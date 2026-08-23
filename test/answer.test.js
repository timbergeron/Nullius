import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdversarialReviewMessages,
  completeAnswer,
  knowledgeModelOverride,
} from "../src/answer.js";
import { OpenRouterError } from "../src/openrouter.js";

const request = {
  apiKey: "secret",
  messages: [
    { role: "system", content: "Use supplied evidence." },
    { role: "user", content: "Where is r_skywind implemented?" },
  ],
  sessionId: "guild:message",
  userId: "user",
};

test("builds a skeptical review turn after the first-pass draft", () => {
  const messages = buildAdversarialReviewMessages(request.messages, "Draft answer.");

  assert.equal(messages.length, 4);
  assert.deepEqual(messages.slice(0, 2), request.messages);
  assert.deepEqual(messages[2], { role: "assistant", content: "Draft answer." });
  assert.match(messages[3].content, /skeptical second-pass audit/);
  assert.match(messages[3].content, /citation mismatches/);
  assert.match(messages[3].content, /Return only the final revised answer/);
  assert.equal(request.messages.length, 2, "the original prompt must not be mutated");
});

test("selects a configured model only for a pack that supplied evidence", () => {
  const models = {
    qssm: "openai/gpt-5.6-luna-pro",
    other: "provider/other-model",
  };

  assert.equal(knowledgeModelOverride(null, models), "");
  assert.equal(knowledgeModelOverride({ packs: [{ id: "unknown" }] }, models), "");
  assert.equal(
    knowledgeModelOverride({ packs: [{ id: "qssm" }] }, models),
    "openai/gpt-5.6-luna-pro",
  );
});

test("leaves ordinary answers single-pass", async () => {
  const calls = [];
  const openRouter = {
    async complete(options) {
      calls.push(options);
      return { text: "First answer.", cost: 0.01, model: "test" };
    },
  };

  const answer = await completeAnswer({ openRouter, ...request });

  assert.equal(calls.length, 1);
  assert.equal(answer.text, "First answer.");
  assert.equal(answer.cost, 0.01);
});

test("adversarially reviews module answers and totals both completion costs", async () => {
  const calls = [];
  const responses = [
    { text: "Plausible but wrong draft.", cost: 0.01, model: "test" },
    { text: "Evidence-checked answer.", cost: 0.02, model: "test" },
  ];
  const openRouter = {
    async complete(options) {
      calls.push(options);
      return responses.shift();
    },
  };

  const answer = await completeAnswer({
    openRouter,
    ...request,
    model: "openai/gpt-5.6-luna-pro",
    adversarialReview: true,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].messages, request.messages);
  assert.equal(calls[0].model, "openai/gpt-5.6-luna-pro");
  assert.equal(calls[1].model, "openai/gpt-5.6-luna-pro");
  assert.equal(calls[1].messages.at(-2).content, "Plausible but wrong draft.");
  assert.match(calls[1].messages.at(-1).content, /Silently fix every issue/);
  assert.equal(answer.text, "Evidence-checked answer.");
  assert.equal(answer.cost, 0.03);
  assert.equal(answer.reviewed, true);
});

test("uses the first-pass answer if review fails and retains known review cost", async () => {
  const warnings = [];
  let calls = 0;
  const openRouter = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "Usable draft.", cost: 0.01, model: "test" };
      throw new OpenRouterError("review timed out", 502, 0.004);
    },
  };

  const answer = await completeAnswer({
    openRouter,
    ...request,
    adversarialReview: true,
    logger: { warn(message, details) { warnings.push({ message, details }); } },
  });

  assert.equal(answer.text, "Usable draft.");
  assert.equal(answer.cost, 0.014);
  assert.equal(answer.reviewed, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /review failed/i);
  assert.equal(JSON.stringify(warnings).includes("Usable draft"), false);
});
