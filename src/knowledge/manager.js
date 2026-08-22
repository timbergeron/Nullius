import { stat } from "node:fs/promises";
import path from "node:path";
import { indexPathFor } from "./build.js";
import { sqliteAvailable, sqliteUnavailableReason } from "./database.js";
import { listPackDirectories, loadManifest } from "./manifest.js";
import { PackIndex } from "./retriever.js";

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export class KnowledgeManager {
  constructor({
    packsDirectory,
    indexDirectory,
    enabled = true,
    maxResults = 12,
    maxCharacters = 16_000,
    logger = console,
  }) {
    this.packsDirectory = packsDirectory;
    this.indexDirectory = indexDirectory;
    this.enabled = enabled;
    this.maxResults = boundedInteger(maxResults, 12, 1, 40);
    this.maxCharacters = boundedInteger(maxCharacters, 16_000, 500, 60_000);
    this.logger = logger;
    this.packs = new Map();
    this.warnings = [];
  }

  async openEntry(entry) {
    const info = await stat(entry.indexPath);
    const index = await PackIndex.open(entry.manifest, entry.indexPath);
    return {
      ...entry,
      index,
      indexMtimeMs: info.mtimeMs,
      indexSize: info.size,
      refreshError: "",
    };
  }

  async init() {
    if (!this.enabled) return this;
    if (!(await sqliteAvailable())) {
      this.warnings.push(sqliteUnavailableReason());
      this.logger.warn?.(`Knowledge packs are disabled: ${sqliteUnavailableReason()}`);
      this.enabled = false;
      return this;
    }

    for (const directory of await listPackDirectories(this.packsDirectory)) {
      let manifest;
      try {
        manifest = await loadManifest(directory);
      } catch (error) {
        this.warnings.push(error.message);
        this.logger.warn?.(`Skipped knowledge pack in ${directory}: ${error.message}`);
        continue;
      }

      const entry = {
        manifest,
        index: null,
        indexPath: indexPathFor(this.indexDirectory, manifest.id),
        indexMtimeMs: 0,
        indexSize: 0,
        refreshError: "",
      };
      try {
        const opened = await this.openEntry(entry);
        this.packs.set(manifest.id, opened);
        this.logger.info?.(
          `Knowledge pack "${manifest.id}" is ready (${manifest.name} ${manifest.version})`,
        );
      } catch (error) {
        const missing = error.code === "ENOENT";
        const message = missing
          ? `${manifest.id}: no index yet — run "npm run knowledge:build -- ${manifest.id}"`
          : `${manifest.id}: ${error.message}`;
        this.warnings.push(message);
        this.logger.warn?.(message);
        this.packs.set(manifest.id, entry);
      }
    }
    return this;
  }

  list() {
    return [...this.packs.values()].map(({ manifest, index }) => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      activation: manifest.activation.mode,
      ready: Boolean(index),
      builtAt: index?.meta?.built_at || "",
    }));
  }

  selected(packIds) {
    const wanted = new Set(packIds || []);
    return [...this.packs.values()].filter((entry) => wanted.has(entry.manifest.id));
  }

  async refreshEntry(entry) {
    let info;
    try {
      info = await stat(entry.indexPath);
    } catch {
      return entry;
    }
    if (
      entry.index &&
      entry.indexMtimeMs === info.mtimeMs &&
      entry.indexSize === info.size
    ) {
      return entry;
    }

    try {
      const replacement = await PackIndex.open(entry.manifest, entry.indexPath);
      entry.index?.close();
      entry.index = replacement;
      entry.indexMtimeMs = info.mtimeMs;
      entry.indexSize = info.size;
      entry.refreshError = "";
      this.logger.info?.(
        `Reloaded knowledge pack "${entry.manifest.id}" (${replacement.meta.fingerprint})`,
      );
    } catch (error) {
      if (entry.refreshError !== error.message) {
        this.logger.warn?.(`Could not reload ${entry.manifest.id}: ${error.message}`);
        entry.refreshError = error.message;
      }
    }
    return entry;
  }

  async retrieve({ packIds, question }) {
    if (!this.enabled || !question?.trim()) return null;
    const entries = this.selected(packIds);
    if (!entries.length) return null;

    const found = [];
    for (const entry of entries) {
      await this.refreshEntry(entry);
      const { manifest, index } = entry;
      if (!index) continue;
      try {
        if (!index.activatesFor(question)) continue;
        found.push(...index.retrieve(question));
      } catch (error) {
        this.logger.warn?.(`Knowledge lookup failed for ${manifest.id}: ${error.message}`);
      }
    }

    found.sort((left, right) =>
      right.score - left.score || left.packId.localeCompare(right.packId));
    const results = [];
    let characters = 0;
    for (const result of found) {
      if (results.length >= this.maxResults) break;
      if (characters + result.body.length > this.maxCharacters) continue;
      characters += result.body.length;
      results.push(result);
    }
    if (!results.length) return null;

    const usedPacks = new Set(results.map((result) => result.packId));
    const packs = entries
      .filter((entry) => usedPacks.has(entry.manifest.id))
      .map(({ manifest }) => ({
        id: manifest.id,
        answerPolicy: manifest.answerPolicy,
      }));
    return { packs, results };
  }

  close() {
    for (const { index } of this.packs.values()) index?.close();
    this.packs.clear();
  }
}

export function defaultDirectories(root) {
  return {
    packsDirectory: path.join(root, "knowledge-packs"),
    indexDirectory: path.join(root, "data", "knowledge"),
  };
}
