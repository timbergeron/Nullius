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
