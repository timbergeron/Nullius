import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectWiki } from "../src/knowledge/wiki.js";

const repo = "https://github.com/timbergeron/QSS-M";
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "nullius-wiki-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "engine", "Quake"), { recursive: true });
  await mkdir(path.join(root, "wiki"));
  const engine = path.join(root, "engine");
  git(engine, "init", "-q");
  git(engine, "config", "user.email", "test@example.invalid");
  git(engine, "config", "user.name", "Test");
  await writeFile(path.join(engine, "Quake/stable.c"), "stable source\n");
  await writeFile(path.join(engine, "Quake/changed.c"), "old source\n");
  await symlink("stable.c", path.join(engine, "Quake/link.c"));
  git(engine, "add", ".");
  git(engine, "commit", "-qm", "snapshot");
  const snapshot = git(engine, "rev-parse", "HEAD");
  await writeFile(path.join(engine, "Quake/changed.c"), "new source\n");
  git(engine, "add", ".");
  git(engine, "commit", "-qm", "advance");
  const current = git(engine, "rev-parse", "HEAD");
  const source = { id: "wiki", type: "files", kind: "wiki", extractor: "qssm-wiki", path: "wiki" };
  const manifest = { id: "qssm", directory: root, sources: [source, {
    id: "engine", type: "git-worktree", kind: "source", path: "engine", ref: "HEAD",
    urlTemplate: `${repo}/blob/{revision}/{path}#L{startLine}`,
  }] };
  const entry = (name, file = "Quake/stable.c", fields = {}) => ({ name, kind: "cvar", file,
    line: 1, url: `${repo}/blob/${snapshot.slice(0, 9)}/${file}#L1`, flags: ["saved"],
    origin: "QSS-M", summary: "Reviewed summary", description: "Reviewed description", ...fields });
  const faq = (id, file = "Quake/stable.c", fields = {}) => ({ id, question: `How to ${id}?`,
    answer: "Use stable_setting [1].", sha: snapshot.slice(0, 9), reviewedAt: "2026-09-29T03:16:48Z",
    citations: [{ label: "Definition", kind: "source", url: `${repo}/blob/${snapshot}/${file}#L1` }],
    related: ["stable_setting"], ...fields });
  const save = async (entries = [], answers = [], extra = {}) => {
    await writeFile(path.join(root, "wiki/reference.json"), JSON.stringify({ source: { repo, sha: snapshot }, entries, ...extra.reference }));
    await writeFile(path.join(root, "wiki/faq.json"), JSON.stringify({ source: { repo, sha: snapshot }, answers, ...extra.faq }));
  };
  const collect = (options = {}) => {
    return collectWiki(source, { manifest, env: {}, ...options });
  };
  return { root, engine, snapshot, current, entry, faq, save, collect, manifest };
}

test("wiki uses committed blob equality and preserves platform and runtime defaults", async (t) => {
  const f = await fixture(t);
  await f.save([f.entry("stable_setting", "Quake/stable.c", { default: "0", defaultByPlatform: { windows: "1", macOS: "0" }, defaultExpression: "desktop_width()" }), f.entry("changed_setting", "Quake/changed.c")]);
  // Dirty working files cannot invalidate reviewed committed evidence.
  await writeFile(path.join(f.engine, "Quake/stable.c"), "dirty working copy\n");
  const result = await f.collect({ revisions: { engine: `main@${f.current.slice(0, 9)}+dirty` } });
  assert.deepEqual(result.documents.map((d) => d.locator), ["stable_setting"]);
  const d = result.documents[0];
  assert.equal(d.kind, "wiki");
  assert.equal(d.revision, f.snapshot);
  assert.equal(d.url, `${repo}/blob/${f.snapshot}/Quake/stable.c#L1`);
  const body = d.chunks.map((c) => c.body).join("\n");
  for (const value of ['Default: "0"', '"windows":"1"', '"macOS":"0"', "desktop_width()", "saved", "QSS-M", "Reviewed summary", "Reviewed description", f.snapshot]) assert.ok(body.includes(value), value);
  assert.equal(d.chunks[0].symbols[0].name, "stable_setting");
  assert.equal(d.chunks[0].symbols[0].kind, "cvar");
});

test("wiki admits reviewed FAQ only when every citation matches snapshot and unchanged blobs", async (t) => {
  const f = await fixture(t);
  await f.save([], [f.faq("stable"), f.faq("changed", "Quake/changed.c"), f.faq("unreviewed", undefined, { reviewedAt: "" }), f.faq("wrongsha", undefined, { sha: f.current }), f.faq("foreign", undefined, { citations: [{ url: `https://github.com/other/QSS-M/blob/${f.snapshot}/Quake/stable.c#L1` }] }), f.faq("mixed", undefined, { citations: [...f.faq("x").citations, ...f.faq("x", "Quake/changed.c").citations] })]);
  const result = await f.collect();
  assert.deepEqual(result.documents.map((d) => d.locator), ["How to stable?"]);
  const d = result.documents[0];
  assert.ok(d.chunks[0].body.includes(`${repo}/blob/${f.snapshot}/Quake/stable.c#L1`));
  assert.ok(!d.chunks[0].body.includes("[1]"));
  assert.equal(d.chunks[0].symbols[0].name, "stable_setting");
});

test("wiki refuses traversal, absolute paths, symlinks and unsafe citation URLs", async (t) => {
  const f = await fixture(t);
  await f.save([f.entry("traversal", "../Quake/stable.c"), f.entry("absolute", "/Quake/stable.c"), f.entry("backslash", "Quake\\stable.c"), f.entry("symlink", "Quake/link.c")], [f.faq("link", "Quake/link.c"), f.faq("unsafe", undefined, { citations: [{ url: "javascript:alert(1)" }] }), f.faq("encoded", undefined, { citations: [{ url: `${repo}/blob/${f.snapshot}/Quake/%2e%2e/Quake/stable.c#L1` }] })]);
  assert.deepEqual((await f.collect()).documents, []);
});

test("wiki fails closed for mismatched snapshot, foreign repo, missing revision, and missing JSON", async (t) => {
  const f = await fixture(t);
  const entries = [f.entry("stable_setting")];
  await f.save(entries, [], { faq: { source: { repo, sha: f.current } } });
  assert.deepEqual((await f.collect()).documents, []);
  await f.save(entries, [], { reference: { source: { repo: "https://github.com/other/QSS-M", sha: f.snapshot } } });
  assert.deepEqual((await f.collect()).documents, []);
  await f.save(entries);
  assert.deepEqual((await f.collect({ revisions: { engine: "0".repeat(40) } })).documents, []);
  await rm(path.join(f.root, "wiki/faq.json"));
  assert.deepEqual((await f.collect()).documents, []);
});

test("wiki splits lengthy evidence with revision and citations in every chunk", async (t) => {
  const f = await fixture(t);
  await f.save([f.entry("long_setting", undefined, { description: "Long evidence. ".repeat(800) })], [f.faq("long", undefined, { answer: "Long FAQ evidence. ".repeat(500) })]);
  const result = await f.collect();
  assert.equal(result.documents.length, 2);
  for (const d of result.documents) {
    assert.ok(d.chunks.length > 1);
    for (const c of d.chunks) {
      assert.ok(c.body.length <= 4000);
      assert.ok(c.body.includes(f.snapshot));
      assert.ok(c.body.includes(d.url));
      assert.ok(c.symbols.length);
    }
  }
});

test("wiki bounds JSON sizes, record counts and malformed fields", async (t) => {
  const f = await fixture(t);
  await f.save(Array.from({ length: 2001 }, () => f.entry("stable_setting")));
  assert.deepEqual((await f.collect()).documents, []);
  await f.save([f.entry("stable_setting", undefined, { summary: "x".repeat(40000) })]);
  assert.deepEqual((await f.collect()).documents, []);
  await f.save([f.entry("stable_setting")]);
  await writeFile(path.join(f.root, "wiki/faq.json"), " ".repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual((await f.collect()).documents, []);
});

test("wiki caps combined reference and FAQ records before indexing", async (t) => {
  const f = await fixture(t);
  await f.save(Array.from({ length: 1001 }, () => f.entry("stable_setting")), Array.from({ length: 1000 }, () => f.faq("stable")));
  assert.equal((await f.collect()).documents.length, 0);
});

test("wiki preserves null runtime defaults distinctly from the literal string null", async (t) => {
  const f = await fixture(t);
  await f.save([
    f.entry("sv_public", undefined, { default: null, defaultExpression: "NULL", description: "Default assigned at runtime." }),
    f.entry("literal_null", undefined, { default: "null" }),
  ]);
  const result = await f.collect();
  assert.deepEqual(result.documents.map((d) => d.locator), ["sv_public", "literal_null"]);
  const runtime = result.documents[0].chunks[0].body;
  assert.ok(runtime.includes("Default: null"));
  assert.ok(!runtime.includes('Default: "null"'));
  assert.ok(runtime.includes("Default expression: NULL"));
  assert.ok(runtime.includes("Default assigned at runtime."));
  assert.ok(result.documents[1].chunks[0].body.includes('Default: "null"'));
});
