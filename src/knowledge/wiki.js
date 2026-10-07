import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveContainedPath, resolveSourcePath } from "./manifest.js";

const run = promisify(execFile);
const FULL_SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[+-]?[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 2000;
const MAX_CHUNK = 4000;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, limit, { optional = false } = {}) {
  return (optional && value === undefined) ||
    (typeof value === "string" && value.length <= limit && !value.includes("\0"));
}

function safePath(value) {
  return text(value, 512) && value.length > 0 &&
    !/^[A-Za-z]:/.test(value) && !/[\\%\x00-\x1f\x7f]/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

async function git(root, args) {
  const { stdout } = await run("git", ["-C", root, "--literal-pathspecs", ...args], {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10000, windowsHide: true,
  });
  return stdout;
}

async function readJson(root, filename) {
  const target = await resolveContainedPath(root, filename, "wiki JSON");
  const handle = await open(target, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new Error("wiki JSON size");
    // A bounded read also handles a file growing after stat without unbounded allocation.
    const buffer = Buffer.alloc(MAX_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_JSON_BYTES) throw new Error("wiki JSON size");
    const value = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    if (!object(value)) throw new Error("wiki JSON shape");
    return value;
  } finally {
    await handle.close();
  }
}

function repository(engine) {
  // The configured authoritative source supplies the expected repository identity.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/\{revision\}\//.exec(engine.urlTemplate || "");
  if (!match || match[2].toLowerCase() !== "qss-m") throw new Error("wiki source repository");
  return `https://github.com/${match[1]}/${match[2]}`;
}

function citation(value, repo, snapshot) {
  if (!text(value, 1600) || !value.startsWith(`${repo}/blob/`)) return null;
  // Parse the original string before URL normalization could erase dot segments.
  const match = /^([a-f0-9]{7,40})\/([^?#]+)#L([1-9][0-9]{0,6})(?:-L([1-9][0-9]{0,6}))?$/.exec(value.slice(`${repo}/blob/`.length));
  if (!match || !snapshot.startsWith(match[1])) return null;
  let file;
  try { file = decodeURIComponent(match[2]); } catch { return null; }
  if (!safePath(file)) return null;
  const line = Number(match[3]);
  const endLine = match[4] ? Number(match[4]) : line;
  if (endLine < line) return null;
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return { file, line, endLine, url: `${repo}/blob/${snapshot}/${encoded}#L${line}${match[4] ? `-L${endLine}` : ""}` };
}

async function committedRevision(root, supplied, fallback) {
  let ref = fallback || "HEAD";
  if (supplied !== undefined) {
    if (typeof supplied !== "string") throw new Error("wiki engine revision");
    ref = supplied.split("@").pop().replace(/\+dirty$/, "");
    if (!/^[a-f0-9]{7,40}$/.test(ref)) throw new Error("wiki engine revision");
  }
  const full = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  if (!FULL_SHA.test(full)) throw new Error("wiki engine revision");
  return full;
}

function unchangedFiles(root, snapshot, current) {
  const cache = new Map();
  async function blob(revision, file) {
    const raw = await git(root, ["ls-tree", "-z", revision, "--", file]);
    const records = raw.split("\0").filter(Boolean);
    if (records.length !== 1) return "";
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(records[0]);
    return match && match[3] === file ? match[2] : "";
  }
  return (file) => {
    if (!safePath(file)) return Promise.resolve(false);
    if (!cache.has(file)) {
      cache.set(file, Promise.all([blob(snapshot, file), blob(current, file)])
        .then(([oldBlob, newBlob]) => Boolean(oldBlob && oldBlob === newBlob)).catch(() => false));
    }
    return cache.get(file);
  };
}

function defaults(entry) {
  if (entry.default !== undefined && entry.default !== null && !text(entry.default, 512)) return null;
  if (entry.defaultExpression !== undefined && !text(entry.defaultExpression, 512)) return null;
  if (entry.defaultByPlatform !== undefined) {
    if (!object(entry.defaultByPlatform) || Object.keys(entry.defaultByPlatform).length > 16 ||
      Object.entries(entry.defaultByPlatform).some(([key, value]) => !/^[A-Za-z0-9_ -]{1,64}$/.test(key) || !text(value, 512))) return null;
  }
  return [
    entry.default !== undefined ? `Default: ${JSON.stringify(entry.default)}` : "",
    entry.defaultByPlatform !== undefined ? `Default by platform: ${JSON.stringify(entry.defaultByPlatform)}` : "",
    entry.defaultExpression !== undefined ? `Default expression: ${entry.defaultExpression}` : "",
  ].filter(Boolean);
}

function makeDocument({ locator, snapshot, url, metadata, prose, symbols, line = 1 }) {
  const header = [...metadata, `Reviewed engine revision: ${snapshot}`, `Source: ${url}`].join("\n");
  if (header.length > 3000) return null;
  const size = MAX_CHUNK - header.length - 2;
  const chunks = [];
  const body = prose || locator;
  for (let offset = 0; offset < body.length;) {
    let end = Math.min(offset + size, body.length);
    // Keep UTF-16 surrogate pairs intact when long prose crosses a chunk boundary.
    if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end -= 1;
    chunks.push({ heading: locator, body: `${header}\n\n${body.slice(offset, end)}`,
      startLine: line, endLine: line, symbols });
    offset = end;
  }
  return { kind: "wiki", locator, title: locator, revision: snapshot, url, chunks };
}

async function referenceDocument(entry, context) {
  if (!object(entry) || !IDENTIFIER.test(entry.name || "") ||
    !["cvar", "command", "param"].includes(entry.kind) || !safePath(entry.file) ||
    !Number.isInteger(entry.line) || entry.line < 1 || entry.line > 9999999 ||
    !["summary", "description", "origin", "category"].every((key) => text(entry[key], key === "description" ? 24000 : 4096, { optional: true })) ||
    !Array.isArray(entry.flags) || entry.flags.length > 32 || entry.flags.some((flag) => !text(flag, 64))) return null;
  const values = defaults(entry);
  if (!values) return null;
  const evidence = citation(entry.url, context.repo, context.snapshot);
  if (!evidence || evidence.file !== entry.file || evidence.line !== entry.line ||
    !await context.unchanged(entry.file)) return null;
  return makeDocument({ locator: entry.name, snapshot: context.snapshot, url: evidence.url,
    metadata: [`${entry.kind}: ${entry.name}`, ...values, `Flags: ${entry.flags.join(", ") || "none"}`,
      entry.origin ? `Origin: ${entry.origin}` : "", entry.category ? `Category: ${entry.category}` : ""].filter(Boolean),
    prose: [entry.summary, entry.description].filter(Boolean).join("\n\n"),
    line: entry.line,
    symbols: [{ name: entry.name, kind: entry.kind, weight: 1, detail: values.join("; ") }],
  });
}

async function faqDocument(answer, context, symbolKinds) {
  if (!object(answer) || !text(answer.id, 128) || !answer.id ||
    !text(answer.question, 512) || !answer.question.trim() || !text(answer.answer, 24000) || !answer.answer.trim() ||
    !text(answer.reviewedAt, 64) || !/^\d{4}-\d{2}-\d{2}T/.test(answer.reviewedAt) || !Number.isFinite(Date.parse(answer.reviewedAt)) ||
    typeof answer.sha !== "string" || !/^[a-f0-9]{7,40}$/.test(answer.sha) || !context.snapshot.startsWith(answer.sha) ||
    !Array.isArray(answer.citations) || !answer.citations.length || answer.citations.length > 16 ||
    (answer.related !== undefined && (!Array.isArray(answer.related) || answer.related.length > 64 ||
      answer.related.some((name) => typeof name !== "string" || !IDENTIFIER.test(name))))) return null;
  const citations = [];
  for (const item of answer.citations) {
    if (!object(item) || (item.kind !== undefined && item.kind !== "source") || !text(item.label, 160, { optional: true })) return null;
    const evidence = citation(item.url, context.repo, context.snapshot);
    if (!evidence || !await context.unchanged(evidence.file)) return null;
    citations.push(evidence);
  }
  const prose = answer.answer.replace(/\[\d+\]/g, "");
  return makeDocument({ locator: answer.question, snapshot: context.snapshot, url: citations[0].url,
    metadata: [`FAQ: ${answer.question}`, `Reviewed at: ${answer.reviewedAt}`,
      ...citations.map((item, index) => `FAQ evidence ${index + 1}: ${answer.citations[index].label || "Source"} — ${item.url}`)],
    prose,
    symbols: [...new Set(answer.related || [])].map((name) => ({ name,
      kind: symbolKinds.get(name) || (name.startsWith("-") ? "param" : "symbol"), weight: 0.9, detail: "Reviewed FAQ" })),
  });
}

/** Import reviewed wiki facts only when their committed source blobs still match. */
export async function collectWiki(source, { manifest, env = process.env, logger, revisions = {} } = {}) {
  const documents = [];
  let revision = "";
  let records = 0;
  try {
    const engines = manifest.sources.filter((item) => item.type === "git-worktree" && item.kind === "source");
    const engine = engines.find((item) => item.id === "engine") || engines[0];
    if (!engine) throw new Error("wiki engine source missing");
    const repo = repository(engine);
    const root = await resolveSourcePath(source, { manifest, env });
    const [reference, faq, engineRoot] = await Promise.all([
      readJson(root, "reference.json"), readJson(root, "faq.json"), resolveSourcePath(engine, { manifest, env }),
    ]);
    const snapshot = reference.source?.sha;
    if (!FULL_SHA.test(snapshot || "") || faq.source?.sha !== snapshot ||
      reference.source?.repo !== repo || faq.source?.repo !== repo ||
      !Array.isArray(reference.entries) || !Array.isArray(faq.answers) ||
      reference.entries.length + faq.answers.length > MAX_RECORDS) throw new Error("wiki snapshot invalid");
    const current = await committedRevision(engineRoot, revisions[engine.id], engine.ref);
    const resolvedSnapshot = await committedRevision(engineRoot, snapshot);
    if (resolvedSnapshot !== snapshot) throw new Error("wiki snapshot unavailable");
    const digest = createHash("sha256").update(JSON.stringify({ reference, faq })).digest("hex").slice(0, 16);
    revision = `${snapshot}@${current}:sha256:${digest}`;
    const context = { repo, snapshot, unchanged: unchangedFiles(engineRoot, snapshot, current) };
    const symbolKinds = new Map();
    records = reference.entries.length + faq.answers.length;
    for (const entry of reference.entries) {
      const document = await referenceDocument(entry, context);
      if (document) { documents.push(document); symbolKinds.set(entry.name, entry.kind); }
    }
    for (const answer of faq.answers) {
      const document = await faqDocument(answer, context, symbolKinds);
      if (document) documents.push(document);
    }
  } catch {
    // Source content and exception messages can contain untrusted evidence; log counts only.
    logger?.warn?.("Wiki evidence unavailable", { documents: 0 });
    return { revision: "", documents: [] };
  }
  logger?.info?.("Wiki evidence collected", { documents: documents.length, skipped: records - documents.length });
  return { revision, documents };
}
