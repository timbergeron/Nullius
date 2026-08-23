import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/store.js";

const secret = "this-is-a-test-secret-with-more-than-32-characters";

test("persists guild settings while encrypting the OpenRouter key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nullius-store-"));
  const file = path.join(directory, "store.json");
  const store = new FileStore(file, secret);
  await store.init();
  await store.ensureGuild({ guildId: "guild", ownerId: "owner", monthlyLimitUsd: 5 });
  await store.setOpenRouterKey("guild", "sk-or-secret");
  await store.incrementTrial("guild");
  await store.addUsageCost("guild", 0.25);
  assert.deepEqual(
    store.getDailyPremiumUsage("guild", "qssm", "2026-08-23T23:59:00Z"),
    { day: "2026-08-23", used: 0 },
  );
  await store.incrementDailyPremiumUsage("guild", "qssm", "2026-08-23T23:59:00Z");
  assert.deepEqual(
    store.getDailyPremiumUsage("guild", "qssm", "2026-08-23T23:59:59Z"),
    { day: "2026-08-23", used: 1 },
  );
  assert.deepEqual(
    store.getDailyPremiumUsage("guild", "qssm", "2026-08-24T00:00:00Z"),
    { day: "2026-08-24", used: 0 },
  );

  assert.equal(store.getOpenRouterKey("guild"), "sk-or-secret");
  assert.equal(store.getGuild("guild").trialUsed, 1);
  assert.equal(store.getMonthlyUsage("guild").cost, 0.25);
  assert.doesNotMatch(await readFile(file, "utf8"), /sk-or-secret/);

  const reloaded = new FileStore(file, secret);
  await reloaded.init();
  assert.equal(reloaded.getOpenRouterKey("guild"), "sk-or-secret");
  assert.deepEqual(
    reloaded.getDailyPremiumUsage("guild", "qssm", "2026-08-23T23:59:59Z"),
    { day: "2026-08-23", used: 1 },
  );
});
