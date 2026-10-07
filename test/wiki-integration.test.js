import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPackIndex } from "../src/knowledge/build.js";
import { normalizeManifest } from "../src/knowledge/manifest.js";
import { KnowledgeManager } from "../src/knowledge/manager.js";
import { buildLlmMessages } from "../src/context.js";
import { completeAnswer } from "../src/answer.js";

test("retrieves reviewed wiki facts into both QSS-M passes and flags an invented draft setting", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nullius-wiki-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = path.join(root, "packs/qssm");
  await mkdir(path.join(pack, "engine/Quake"), { recursive: true });
  await mkdir(path.join(pack, "wiki"));
  const git = (...args) => execFileSync("git", ["-C", path.join(pack, "engine"), ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(pack, "engine/Quake/view.c"), 'cvar_t fov = {"fov", "90", CVAR_ARCHIVE};\n');
  git("add", "."); git("commit", "-qm", "source fixture");
  const sha = git("rev-parse", "HEAD");
  const repo = "https://github.com/timbergeron/QSS-M";
  const url = `${repo}/blob/${sha}/Quake/view.c#L1`;
  const source = { repo, sha };
  await writeFile(path.join(pack, "wiki/reference.json"), JSON.stringify({ source, entries: [{ name: "fov", kind: "cvar", default: "90", flags: ["saved"], file: "Quake/view.c", line: 1, url, description: "Sets field of view." }] }));
  await writeFile(path.join(pack, "wiki/faq.json"), JSON.stringify({ source, answers: [{ id: "view", question: "How do I change field of view?", answer: "Use `fov 110` to widen the field of view [1].", sha, reviewedAt: "2026-09-29T03:16:48Z", related: ["fov"], citations: [{ url, kind: "source", label: "Field of view" }] }] }));
  const raw = { schemaVersion: 1, id: "qssm", name: "QSS-M", version: "1.0.0", activation: { mode: "auto", keywords: ["QSS-M"] },
    retrieval: { maxResults: 8, maxCharacters: 12000 }, sources: [
      { id: "engine", type: "git-worktree", path: "engine", kind: "source", ref: "HEAD", extractor: "c-source", include: ["Quake/*.c"], urlTemplate: `${repo}/blob/{revision}/{path}#L{startLine}` },
      { id: "wiki", type: "files", path: "wiki", kind: "wiki", extractor: "qssm-wiki", authority: 0.9 },
    ], answerPolicy: { sourceOrder: ["engine", "wiki"] } };
  await writeFile(path.join(pack, "manifest.json"), JSON.stringify(raw));
  await buildPackIndex(normalizeManifest(raw, { directory: pack }), { directory: path.join(root, "index") });
  const manager = await new KnowledgeManager({ packsDirectory: path.join(root, "packs"), indexDirectory: path.join(root, "index") }).init();
  t.after(() => manager.close());
  const question = "QSS-M: how do I change my field of view?";
  const retrieved = await manager.retrieve({ packIds: ["qssm"], question });
  assert.ok(retrieved.results.some((r) => r.sourceId === "wiki" && r.body.includes("fov 110")));
  assert.ok(retrieved.results.some((r) => r.sourceId === "wiki" && r.body.includes('Default: "90"')));
  const messages = buildLlmMessages([{ id: "test", content: question, author: { username: "Tester" } }], { botId: "bot", maxCharacters: 16000, knowledge: retrieved });
  const requests = [];
  const answer = await completeAnswer({ messages, apiKey: "test", sessionId: "test", userId: "test", model: "sol", reviewModel: "opus", adversarialReview: true,
    reviewHints: (draft) => manager.reviewHints({ packIds: ["qssm"], draft }),
    openRouter: { async complete(options) { requests.push(options); return { text: requests.length === 1 ? "Use `r_fake_fov 110`." : "Use `fov 110`.", cost: 0.001 }; } },
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("fov 110")));
  assert.ok(requests.every((request) => JSON.stringify(request.messages).includes(sha)));
  assert.match(requests[1].messages.at(-1).content, /r_fake_fov/);
  assert.equal(answer.text, "Use `fov 110`.");
  assert.equal(answer.cost, 0.002);
});
