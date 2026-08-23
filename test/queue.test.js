import assert from "node:assert/strict";
import test from "node:test";
import { RequestQueue } from "../src/queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("processes queued requests in FIFO order", async () => {
  const gates = new Map([["first", deferred()], ["second", deferred()]]);
  const handled = [];
  const queue = new RequestQueue({
    async handle(item) {
      handled.push(item.id);
      await gates.get(item.id)?.promise;
    },
  });

  assert.deepEqual(
    queue.enqueue("guild", { id: "first", userId: "a" }),
    { status: "started", position: 0 },
  );
  assert.deepEqual(
    queue.enqueue("guild", { id: "second", userId: "b" }),
    { status: "queued", position: 1 },
  );
  assert.deepEqual(
    queue.enqueue("guild", { id: "third", userId: "c" }),
    { status: "queued", position: 2 },
  );

  assert.deepEqual(handled, ["first"]);
  gates.get("first").resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, ["first", "second"]);
  gates.get("second").resolve();
  await queue.whenIdle("guild");
  assert.deepEqual(handled, ["first", "second", "third"]);
  assert.equal(queue.isActive("guild"), false);
});

test("allows one waiting request per user and enforces the pending limit", async () => {
  const gate = deferred();
  const queue = new RequestQueue({
    maxPending: 2,
    async handle(item) {
      if (item.id === "active") await gate.promise;
    },
  });

  queue.enqueue("guild", { id: "active", userId: "a" });
  assert.equal(queue.enqueue("guild", { id: "b1", userId: "b" }).status, "queued");
  assert.equal(queue.enqueue("guild", { id: "b2", userId: "b" }).status, "duplicate");
  assert.equal(queue.enqueue("guild", { id: "c", userId: "c" }).status, "queued");
  assert.equal(queue.enqueue("guild", { id: "d", userId: "d" }).status, "full");

  gate.resolve();
  await queue.whenIdle("guild");
});

test("expires stale requests without blocking later work", async () => {
  let now = 0;
  const gate = deferred();
  const handled = [];
  const expired = [];
  const queue = new RequestQueue({
    maxAgeMs: 60_000,
    now: () => now,
    async handle(item) {
      handled.push(item.id);
      if (item.id === "active") await gate.promise;
    },
    async onExpired(item) {
      expired.push(item.id);
    },
  });

  queue.enqueue("guild", { id: "active", userId: "a" });
  queue.enqueue("guild", { id: "stale", userId: "b" });
  now = 60_001;
  queue.enqueue("guild", { id: "fresh", userId: "c" });
  gate.resolve();
  await queue.whenIdle("guild");

  assert.deepEqual(handled, ["active", "fresh"]);
  assert.deepEqual(expired, ["stale"]);
});

test("continues draining after a handler error", async () => {
  const errors = [];
  const handled = [];
  const gate = deferred();
  const queue = new RequestQueue({
    async handle(item) {
      handled.push(item.id);
      if (item.id === "first") {
        await gate.promise;
        throw new Error("failed");
      }
    },
    logger: { error(message, error) { errors.push({ message, error }); } },
  });

  queue.enqueue("guild", { id: "first", userId: "a" });
  queue.enqueue("guild", { id: "second", userId: "b" });
  gate.resolve();
  await queue.whenIdle("guild");

  assert.deepEqual(handled, ["first", "second"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.message, "failed");
});
