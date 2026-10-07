import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectSource } from "../src/knowledge/sources.js";

const run = promisify(execFile);

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nullius-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await run("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Source Test");
  await git("config", "user.email", "source-test@example.invalid");
  const commit = async () => {
    await git("add", ".");
    await git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const collect = (overrides = {}) => collectSource({
    id: "code", type: "git-worktree", kind: "source", path: ".", ref: "HEAD",
    include: ["**"], exclude: [], extractor: "text",
    urlTemplate: "https://example.invalid/blob/{revision}/{path}#L{startLine}",
    ...overrides,
  }, { manifest: { id: "sample", directory: root }, logger: { warn() {} } });
  return { root, git, commit, collect };
}

test("git sources read committed content despite dirty, deleted, staged, and untracked files", async (t) => {
  const { root, git, commit, collect } = await repository(t);
  await writeFile(path.join(root, "changed.txt"), "committed original\n");
  await writeFile(path.join(root, "deleted.txt"), "committed deleted\n");
  const revision = await commit();
  await writeFile(path.join(root, "changed.txt"), "dirty replacement\n");
  await rm(path.join(root, "deleted.txt"));
  await writeFile(path.join(root, "untracked.txt"), "untracked content\n");
  await writeFile(path.join(root, "staged.txt"), "staged content\n");
  await git("add", "staged.txt");
  const result = await collect();
  assert.equal(result.revision, revision);
  assert.deepEqual(result.documents.map((doc) => doc.locator), ["changed.txt", "deleted.txt"]);
  assert.match(result.documents[0].chunks[0].body, /committed original/);
  assert.match(result.documents[1].chunks[0].body, /committed deleted/);
  assert.ok(result.documents.every((doc) => doc.revision === revision && doc.url.includes(revision)));
});

test("git sources resolve the configured non-HEAD ref to its full commit", async (t) => {
  const { root, git, commit, collect } = await repository(t);
  await writeFile(path.join(root, "before.txt"), "first revision\n");
  const revision = await commit();
  await git("tag", "snapshot");
  await rm(path.join(root, "before.txt"));
  await writeFile(path.join(root, "after.txt"), "second revision\n");
  await commit();
  const result = await collect({ ref: "snapshot" });
  assert.equal(result.revision, revision);
  assert.deepEqual(result.documents.map((doc) => doc.locator), ["before.txt"]);
  assert.match(result.documents[0].chunks[0].body, /first revision/);
});

test("nested git source roots match local paths and cite repository-relative paths", async (t) => {
  const { root, commit, collect } = await repository(t);
  await mkdir(path.join(root, "engine", "sub"), { recursive: true });
  await writeFile(path.join(root, "outside.txt"), "outside root\n");
  await writeFile(path.join(root, "engine", "sub", "menu.c"), "void DrawMenu(void) {}\n");
  const revision = await commit();
  const result = await collect({ path: "engine", include: ["sub/*.c"] });
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].locator, "sub/menu.c");
  assert.equal(result.documents[0].url, `https://example.invalid/blob/${revision}/engine/sub/menu.c#L1`);
});

test("git sources include files over 512 KiB and reject files over 2 MiB and binary blobs", async (t) => {
  const { root, commit, collect } = await repository(t);
  await writeFile(path.join(root, "menu.c"), `void DrawMenu(void) {}\n${"// menu details\n".repeat(40000)}`);
  await writeFile(path.join(root, "oversized.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  await writeFile(path.join(root, "binary.txt"), Buffer.from([65, 0, 66]));
  await commit();
  const result = await collect();
  assert.deepEqual(result.documents.map((doc) => doc.locator), ["menu.c"]);
  assert.match(result.documents[0].chunks[0].body, /DrawMenu/);
});

test("git sources exclude committed symlinks even when their targets are readable", async (t) => {
  const { root, commit, collect } = await repository(t);
  await writeFile(path.join(root, "target.txt"), "readable target\n");
  await symlink("target.txt", path.join(root, "link.txt"));
  await commit();
  const result = await collect();
  assert.deepEqual(result.documents.map((doc) => doc.locator), ["target.txt"]);
});
