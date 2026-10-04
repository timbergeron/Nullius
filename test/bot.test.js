import assert from "node:assert/strict";
import test from "node:test";
import { createBot, splitDiscordMessage } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/openrouter.js";

test("splits long Discord answers at readable boundaries", () => {
  const text = `${"First paragraph. ".repeat(20)}\n\n${"Second paragraph. ".repeat(20)}`;
  const parts = splitDiscordMessage(text, 180);

  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 180));
  assert.match(parts[0], /First paragraph/);
  assert.match(parts.at(-1), /Second paragraph/);
});

test("closes and reopens fenced code across Discord messages", () => {
  const sourceLines = Array.from(
    { length: 40 },
    (_, index) => `  const value${index} = ${index};`,
  );
  const text = `Here is the implementation:\n\n\`\`\`js\n${sourceLines.join("\n")}\n\`\`\`\n\nDone.`;
  const parts = splitDiscordMessage(text, 220);

  assert.ok(parts.length > 2);
  assert.ok(parts.every((part) => part.length <= 220));
  assert.ok(parts.every((part) => (part.match(/```/g) || []).length % 2 === 0));
  assert.ok(parts.slice(1, -1).some((part) => part.startsWith("```js\n")));
  assert.match(parts.join("\n"), /  const value20 = 20;/);
  assert.match(parts.at(-1), /Done\.$/);
});

async function invokeBot(t, { content, attachments = new Map(), recent = [], knowledge = null, fetchImpl }) {
  const config = loadConfig({
    APP_SECRET: "a".repeat(32), DISCORD_CLIENT_ID: "client",
    DISCORD_CLIENT_SECRET: "secret", DISCORD_BOT_TOKEN: "token",
    QSSM_OPENROUTER_MODEL: "provider/text", QSSM_PREMIUM_OPENROUTER_MODEL: "provider/premium",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });
  const costs = [];
  let premiumUses = 0;
  let reply;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const logger = {
    info(message) { if (message === "Discord request finished") finish(); },
    warn() {}, error() {},
  };
  const bot = createBot({
    config, knowledge, logger,
    openRouter: new OpenRouterClient({ ...config.openRouter, publicUrl: config.publicUrl, logger }),
    store: {
      getGuild() { return { monthlyLimitUsd: 5, knowledgePacks: ["qssm"] }; },
      getOpenRouterKey() { return "secret"; },
      getMonthlyUsage() { return { cost: 0 }; },
      getDailyPremiumUsage() { return { used: 0, day: "2026-10-04" }; },
      async incrementDailyPremiumUsage() { premiumUses += 1; },
      async addUsageCost(_guildId, cost) { costs.push(cost); },
    },
  });
  bot.user = { id: "999" };
  t.after(() => bot.destroy());
  const message = {
    id: "501", content, attachments, createdTimestamp: 501_000,
    author: { id: "user", username: "Maya", bot: false }, guildId: "guild", channelId: "channel",
    mentions: { users: new Map([["999", bot.user]]) },
    channel: { async sendTyping() {}, messages: { async fetch() { return new Map(recent.map((item) => [item.id, item])); } } },
    async reply(options) { reply = options; },
  };
  await bot.listeners("messageCreate")[0](message);
  await Promise.race([finished, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("bot did not finish")), 2000);
    t.after(() => clearTimeout(timer));
  })]);
  return { reply, costs, premiumUses };
}

function providerResponse(text = "The screenshot shows a red square.") {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: text } }],
    usage: { cost: 0.001, completion_tokens: 10 },
  }), { headers: { "content-type": "application/json" } });
}

test("accepts an image-only mention and sends image bytes to the vision model", async (t) => {
  const requests = [];
  const result = await invokeBot(t, {
    content: "<@999>",
    attachments: new Map([["image", { name: "square.png", contentType: "image/png", size: 4, url: "https://cdn.discordapp.com/attachments/channel/501/square.png" }]]),
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://cdn.discordapp.com/")) return new Response("data", { headers: { "content-type": "image/png" } });
      requests.push(JSON.parse(options.body));
      return providerResponse();
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "google/gemini-3-flash-preview");
  assert.match(JSON.stringify(requests[0].messages), /data:image\/png;base64/);
  assert.match(result.reply.content, /red square/);
  assert.deepEqual(result.costs, [0.001]);
});

test("gives both knowledge passes the recent image and preserves the premium quota", async (t) => {
  const requests = [];
  const result = await invokeBot(t, {
    content: "<@999> why does this screenshot look broken in QSS-M?",
    recent: [{ id: "500", createdTimestamp: 500_000, content: "QSS-M renderer", author: { username: "Lee" }, attachments: new Map([["image", { name: "bug.png", contentType: "image/png", size: 4, url: "https://cdn.discordapp.com/attachments/channel/500/bug.png" }]]) }],
    knowledge: { async retrieve() { return { packs: [{ id: "qssm" }], results: [{ packId: "qssm", sourceId: "code", locator: "Quake/gl_rmain.c", body: "R_RenderScene draws the scene.", startLine: 10 }] }; } },
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://cdn.discordapp.com/")) return new Response("data", { headers: { "content-type": "image/png" } });
      requests.push(JSON.parse(options.body));
      return providerResponse();
    },
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.model === "google/gemini-3-flash-preview"));
  assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("data:image/png;base64")));
  assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("R_RenderScene draws the scene.")));
  assert.equal(result.premiumUses, 0);
  assert.deepEqual(result.costs, [0.002]);
});

test("keeps ordinary requests on the text model without downloading nearby images", async (t) => {
  const requests = [];
  await invokeBot(t, {
    content: "<@999> hello",
    recent: [{ id: "500", createdTimestamp: 500_000, content: "", author: { username: "Lee" }, attachments: new Map([["image", { name: "bug.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/channel/500/bug.png" }]]) }],
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      requests.push(JSON.parse(options.body));
      return providerResponse("Hello.");
    },
  });
  assert.equal(requests[0].model, "openai/gpt-6-luna");
  assert.equal(requests.length, 1);
});
