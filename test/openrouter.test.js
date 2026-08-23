import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterClient, OpenRouterError } from "../src/openrouter.js";

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function completion({ content, finishReason = "stop", cost = 0, reasoningTokens = 0 }) {
  return {
    model: "deepseek/deepseek-v4-flash",
    choices: [{
      finish_reason: finishReason,
      message: { content },
    }],
    usage: {
      cost,
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    },
  };
}

function client(logger = { warn() {} }) {
  return new OpenRouterClient({
    model: "deepseek/deepseek-v4-flash",
    maxOutputTokens: 1600,
    retryOutputTokens: 4096,
    publicUrl: "https://example.test/nullius",
    logger,
  });
}

test("uses max_completion_tokens for a successful completion", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(completion({ content: "  A complete answer.  ", cost: 0.01 }));
  };

  const result = await client().complete({
    apiKey: "secret",
    messages: [{ role: "user", content: "Question" }],
    sessionId: "guild:message",
    userId: "user",
  });

  assert.equal(requestBody.max_completion_tokens, 1600);
  assert.equal("max_tokens" in requestBody, false);
  assert.equal(result.text, "A complete answer.");
  assert.equal(result.cost, 0.01);
});

test("retries a length-limited answer with the larger budget", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  const warnings = [];
  const bodies = [
    completion({
      content: "An unfinished answer `",
      finishReason: "length",
      cost: 0.01,
      reasoningTokens: 1200,
    }),
    completion({ content: "The complete answer.", cost: 0.02 }),
  ];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response(bodies.shift());
  };

  const result = await client({
    warn(message, details) {
      warnings.push({ message, details });
    },
  }).complete({
    apiKey: "secret",
    messages: [{ role: "user", content: "Question" }],
    sessionId: "guild:message",
    userId: "user",
  });

  assert.deepEqual(
    requests.map((request) => request.max_completion_tokens),
    [1600, 4096],
  );
  assert.equal(result.text, "The complete answer.");
  assert.equal(result.cost, 0.03);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].details.finishReason, "length");
  assert.equal(warnings[0].details.reasoningTokens, 1200);
  assert.equal(warnings[0].details.nextMaxCompletionTokens, 4096);
  assert.equal(JSON.stringify(warnings).includes("Question"), false);
});

test("retries an empty answer and fails cleanly if the retry is also empty", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(completion({ content: "", cost: 0.005 }));
  };

  await assert.rejects(
    client().complete({
      apiKey: "secret",
      messages: [{ role: "user", content: "Question" }],
      sessionId: "guild:message",
      userId: "user",
    }),
    (error) => error instanceof OpenRouterError
      && error.status === 502
      && error.message === "The model returned an empty answer"
      && error.cost === 0.01,
  );
  assert.equal(calls, 2);
});
