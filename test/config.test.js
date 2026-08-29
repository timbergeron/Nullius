import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const requiredEnv = {
  APP_SECRET: "a".repeat(32),
  DISCORD_CLIENT_ID: "client",
  DISCORD_CLIENT_SECRET: "secret",
  DISCORD_BOT_TOKEN: "token",
};

test("defaults recent channel context to ten messages", () => {
  assert.equal(loadConfig(requiredEnv).context.recentMessages, 10);
});

test("uses reasoning-safe OpenRouter budgets and a bounded timeout", () => {
  const defaults = loadConfig(requiredEnv).openRouter;
  assert.equal(defaults.maxOutputTokens, 4096);
  assert.equal(defaults.retryOutputTokens, 8192);
  assert.equal(defaults.requestTimeoutMs, 90_000);

  assert.equal(
    loadConfig({ ...requiredEnv, OPENROUTER_TIMEOUT_SECONDS: "1000" })
      .openRouter.requestTimeoutMs,
    180_000,
  );
});

test("supports an optional QSS-M model override", () => {
  const defaults = loadConfig(requiredEnv).openRouter;
  assert.equal(defaults.packModels.qssm, "");
  assert.equal(defaults.packPremium.qssm.model, "");
  assert.equal(defaults.packPremium.qssm.dailyLimit, 1);
  assert.equal(
    loadConfig({
      ...requiredEnv,
      QSSM_OPENROUTER_MODEL: "  openai/gpt-5.6-luna-pro  ",
    }).openRouter.packModels.qssm,
    "openai/gpt-5.6-luna-pro",
  );

  const premium = loadConfig({
    ...requiredEnv,
    QSSM_PREMIUM_OPENROUTER_MODEL: "  openai/gpt-5.6-sol  ",
    QSSM_PREMIUM_DAILY_LIMIT: "2",
  }).openRouter.packPremium.qssm;
  assert.deepEqual(premium, { model: "openai/gpt-5.6-sol", dailyLimit: 2 });
  assert.equal(
    loadConfig({ ...requiredEnv, QSSM_PREMIUM_DAILY_LIMIT: "100" })
      .openRouter.packPremium.qssm.dailyLimit,
    10,
  );
});

test("allows recent channel context to be disabled and caps Discord fetches", () => {
  assert.equal(
    loadConfig({ ...requiredEnv, CHANNEL_CONTEXT_MESSAGES: "0" }).context.recentMessages,
    0,
  );
  assert.equal(
    loadConfig({ ...requiredEnv, CHANNEL_CONTEXT_MESSAGES: "500" }).context.recentMessages,
    100,
  );
  assert.throws(
    () => loadConfig({ ...requiredEnv, CHANNEL_CONTEXT_MESSAGES: "-1" }),
    /must be zero or a positive number/,
  );
});

test("applies bounded request queue defaults and overrides", () => {
  const defaults = loadConfig(requiredEnv).queue;
  assert.equal(defaults.maxPending, 5);
  assert.equal(defaults.maxAgeMs, 300_000);

  const capped = loadConfig({
    ...requiredEnv,
    REQUEST_QUEUE_MAX_PENDING: "100",
    REQUEST_QUEUE_MAX_AGE_SECONDS: "1000",
  }).queue;
  assert.equal(capped.maxPending, 25);
  assert.equal(capped.maxAgeMs, 300_000);
  assert.equal(
    loadConfig({ ...requiredEnv, REQUEST_QUEUE_MAX_PENDING: "0.5" }).queue.maxPending,
    1,
  );
});
