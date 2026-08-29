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
    maxOutputTokens: 4096,
    retryOutputTokens: 8192,
    requestTimeoutMs: 90_000,
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

  assert.equal(requestBody.max_completion_tokens, 4096);
  assert.equal("max_tokens" in requestBody, false);
  assert.equal(result.text, "A complete answer.");
  assert.equal(result.cost, 0.01);
});

test("allows a completion to override the configured model", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(completion({ content: "QSS-M answer." }));
  };

  await client().complete({
    apiKey: "secret",
    messages: [{ role: "user", content: "Question" }],
    sessionId: "guild:message",
    userId: "user",
    model: "openai/gpt-5.6-luna-pro",
  });

  assert.equal(requestBody.model, "openai/gpt-5.6-luna-pro");
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
    [4096, 8192],
  );
  assert.equal(result.text, "The complete answer.");
  assert.equal(result.cost, 0.03);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].details.finishReason, "length");
  assert.equal(warnings[0].details.reasoningTokens, 1200);
  assert.equal(warnings[0].details.nextMaxCompletionTokens, 8192);
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

test("logs safe timing metadata for completed attempts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const entries = [];
  const times = [1_000, 1_125];
  globalThis.fetch = async () => response(completion({
    content: "Timed answer.",
    reasoningTokens: 300,
  }));

  const openRouter = new OpenRouterClient({
    model: "z-ai/glm-5.3-flash",
    maxOutputTokens: 4096,
    retryOutputTokens: 8192,
    requestTimeoutMs: 90_000,
    publicUrl: "https://example.test/nullius",
    logger: {
      info(message, details) { entries.push({ message, details }); },
    },
    now: () => times.shift(),
  });
  await openRouter.complete({
    apiKey: "secret",
    messages: [{ role: "user", content: "Do not log this question" }],
    sessionId: "guild:message",
    userId: "user",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "OpenRouter completion attempt finished");
  assert.equal(entries[0].details.elapsedMs, 125);
  assert.equal(entries[0].details.maxCompletionTokens, 4096);
  assert.equal(entries[0].details.reasoningTokens, 300);
  assert.equal(JSON.stringify(entries).includes("Do not log this question"), false);
  assert.equal(JSON.stringify(entries).includes("secret"), false);
});

test("logs timeout metadata without prompts or credentials", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const entries = [];
  const times = [2_000, 92_000];
  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };

  const openRouter = new OpenRouterClient({
    model: "z-ai/glm-5.3-flash",
    maxOutputTokens: 4096,
    retryOutputTokens: 8192,
    requestTimeoutMs: 90_000,
    publicUrl: "https://example.test/nullius",
    logger: {
      error(message, details) { entries.push({ message, details }); },
    },
    now: () => times.shift(),
  });

  await assert.rejects(openRouter.complete({
    apiKey: "secret",
    messages: [{ role: "user", content: "Do not log this question" }],
    sessionId: "guild:message",
    userId: "user",
  }), /timeout/);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "OpenRouter completion attempt failed");
  assert.equal(entries[0].details.elapsedMs, 90_000);
  assert.equal(entries[0].details.attempt, 1);
  assert.equal(JSON.stringify(entries).includes("Do not log this question"), false);
  assert.equal(JSON.stringify(entries).includes("secret"), false);
});
