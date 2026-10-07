import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("answer evaluation requires explicit live mode before reading credentials or running models", () => {
  const result = spawnSync(process.execPath, ["scripts/evaluate-answers.js"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--live/);
  assert.doesNotMatch(result.stderr, /OPENROUTER_API_KEY/);
});
