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

async function invokeBot(t, { content, attachments = new Map(), recent = [], knowledge = null, premiumUsed = 0, fetchImpl }) {
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
      getDailyPremiumUsage() { return { used: premiumUsed, day: "2026-10-04" }; },
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

test("accepts an image-only mention and sends image bytes to the normal chat model", async (t) => {
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
  assert.equal(requests[0].model, "anthropic/claude-haiku-5.5");
  assert.match(JSON.stringify(requests[0].messages), /data:image\/png;base64/);
  assert.match(result.reply.content, /red square/);
  assert.deepEqual(result.costs, [0.001]);
});

test("gives the QSS-M draft and premium review the recent image and charges the quota", async (t) => {
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
  assert.deepEqual(requests.map((request) => request.model), ["provider/text", "provider/premium"]);
  assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("data:image/png;base64")));
  assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("R_RenderScene draws the scene.")));
  assert.equal(result.premiumUses, 1);
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
  assert.equal(requests[0].model, "anthropic/claude-haiku-5.5");
  assert.equal(requests.length, 1);
});

function videoBytes() {
  const mp4 = Buffer.alloc(56);
  mp4.writeUInt32BE(20, 0); mp4.write("ftyp", 4);
  mp4.writeUInt32BE(36, 20); mp4.write("moov", 24);
  mp4.writeUInt32BE(28, 28); mp4.write("mvhd", 32);
  mp4.writeUInt32BE(1000, 48); mp4.writeUInt32BE(2000, 52);
  return mp4;
}

test("accepts a video-only mention and sends native video parts to the vision model", async (t) => {
  const requests = [];
  const mp4 = videoBytes();
  const result = await invokeBot(t, {
    content: "<@999>",
    attachments: new Map([["video", { name: "throne.mp4", contentType: "video/mp4", size: mp4.length, url: "https://cdn.discordapp.com/attachments/channel/501/throne.mp4" }]]),
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://cdn.discordapp.com/")) return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      requests.push(JSON.parse(options.body));
      return providerResponse("The clip shows a throne.");
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "google/gemini-3-flash-preview");
  const video = requests[0].messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((part) => part.type === "video_url");
  assert.match(video.video_url.url, /^data:video\/mp4;base64,/);
  assert.match(result.reply.content, /throne/);
});

test("routes iPhone MOV attachments to vision with a provider-compatible MIME", async (t) => {
  const requests = [];
  const mov = videoBytes();
  const result = await invokeBot(t, {
    content: "<@999> what is in this video",
    attachments: new Map([["video", { name: "iphone.mov", contentType: "video/quicktime", size: mov.length, url: "https://cdn.discordapp.com/attachments/channel/501/iphone.mov" }]]),
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://cdn.discordapp.com/")) return new Response(mov, { headers: { "content-type": "video/quicktime" } });
      requests.push(JSON.parse(options.body));
      return providerResponse("The video shows a room.");
    },
  });
  assert.equal(requests[0].model, "google/gemini-3-flash-preview");
  const video = requests[0].messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((part) => part.type === "video_url");
  assert.match(video.video_url.url, /^data:video\/mov;base64,/);
  assert.match(result.reply.content, /room/);
});

const qssmKnowledge = {
  async retrieve() {
    return { packs: [{ id: "qssm" }], results: [{ packId: "qssm", sourceId: "code", locator: "Quake/gl_rmain.c", body: "R_RenderScene draws the scene.", startLine: 10 }] };
  },
};

for (const scenario of [
  { name: "image with exhausted quota", video: false, premiumUsed: 1, models: ["provider/text", "provider/text"], premiumUses: 0 },
  { name: "mixed image and video", video: true, premiumUsed: 0, models: ["google/gemini-3-flash-preview", "google/gemini-3-flash-preview"], premiumUses: 0 },
  { name: "image with unavailable video", video: true, unavailable: true, premiumUsed: 0, models: ["provider/text", "provider/premium"], premiumUses: 1 },
  { name: "image with failed premium review", video: false, premiumUsed: 0, failedReview: true, models: ["provider/text", "provider/premium"], premiumUses: 0 },
]) {
  test(`routes QSS-M ${scenario.name} and retains visual evidence`, async (t) => {
    const requests = [];
    const mp4 = videoBytes();
    const attachments = new Map([["image", { name: "bug.png", contentType: "image/png", size: 4, url: "https://cdn.discordapp.com/attachments/channel/501/bug.png" }]]);
    if (scenario.video) attachments.set("video", { name: "bug.mp4", contentType: "video/mp4", size: mp4.length, url: "https://cdn.discordapp.com/attachments/channel/501/bug.mp4" });
    const result = await invokeBot(t, {
      content: "<@999> why is this QSS-M scene broken?", attachments,
      knowledge: qssmKnowledge, premiumUsed: scenario.premiumUsed,
      fetchImpl: async (url, options) => {
        if (url.endsWith("bug.png")) return new Response("data", { headers: { "content-type": "image/png" } });
        if (url.endsWith("bug.mp4")) return scenario.unavailable
          ? new Response("unavailable", { status: 404 })
          : new Response(mp4, { headers: { "content-type": "video/mp4" } });
        requests.push(JSON.parse(options.body));
        if (scenario.failedReview && requests.length === 2) return new Response("provider unavailable", { status: 503 });
        return providerResponse();
      },
    });
    assert.deepEqual(requests.map((request) => request.model), scenario.models);
    assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("data:image/png;base64")));
    assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("R_RenderScene draws the scene.")));
    assert.equal(requests.some((request) => JSON.stringify(request.messages).includes("data:video/mp4;base64")), scenario.video && !scenario.unavailable);
    assert.equal(result.premiumUses, scenario.premiumUses);
    assert.deepEqual(result.costs, [scenario.failedReview ? 0.001 : 0.002]);
    assert.match(result.reply.content, /red square/);
  });
}
