import assert from "node:assert/strict";
import test from "node:test";
import { maintainTyping, TYPING_REFRESH_MS } from "../src/typing.js";

test("refreshes typing immediately and periodically until stopped", async () => {
  let calls = 0;
  let scheduled;
  let scheduledEvery;
  let cleared = null;
  let unrefCalled = false;
  const timer = { unref() { unrefCalled = true; } };
  const channel = {
    async sendTyping() {
      calls += 1;
    },
  };

  const stop = maintainTyping(channel, {
    setIntervalFn(callback, intervalMs) {
      scheduled = callback;
      scheduledEvery = intervalMs;
      return timer;
    },
    clearIntervalFn(value) {
      cleared = value;
    },
  });

  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(scheduledEvery, TYPING_REFRESH_MS);
  assert.equal(unrefCalled, true);

  await scheduled();
  assert.equal(calls, 2);

  stop();
  assert.equal(cleared, timer);
  await scheduled();
  assert.equal(calls, 2);
});

test("does not overlap slow typing refreshes or propagate their failures", async () => {
  let calls = 0;
  let scheduled;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const channel = {
    async sendTyping() {
      calls += 1;
      if (calls === 1) await pending;
      else throw new Error("Missing permission");
    },
  };

  const stop = maintainTyping(channel, {
    setIntervalFn(callback) {
      scheduled = callback;
      return 1;
    },
    clearIntervalFn() {},
  });

  await scheduled();
  assert.equal(calls, 1);
  release();
  await pending;
  await Promise.resolve();
  await scheduled();
  assert.equal(calls, 2);
  stop();
});
