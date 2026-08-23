import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret } from "./security.js";

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function utcDay(at = new Date()) {
  return new Date(at).toISOString().slice(0, 10);
}

export class FileStore {
  constructor(filePath, secret) {
    this.filePath = filePath;
    this.secret = secret;
    this.data = { version: 1, guilds: {} };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed.version !== 1 || typeof parsed.guilds !== "object") {
        throw new Error("Unsupported store format");
      }
      this.data = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  getGuild(guildId) {
    const guild = this.data.guilds[guildId];
    return guild ? structuredClone(guild) : null;
  }

  async ensureGuild({ guildId, ownerId, monthlyLimitUsd }) {
    const now = new Date().toISOString();
    const existing = this.data.guilds[guildId];
    this.data.guilds[guildId] = {
      installedAt: existing?.installedAt || now,
      nickname: existing?.nickname || "",
      openRouterKey: existing?.openRouterKey || null,
      trialUsed: existing?.trialUsed || 0,
      monthlyLimitUsd: existing?.monthlyLimitUsd || monthlyLimitUsd,
      knowledgePacks: existing?.knowledgePacks || [],
      usage: existing?.usage || { month: currentMonth(), cost: 0 },
      ...existing,
      ownerId,
      updatedAt: now,
    };
    await this.persist();
    return this.getGuild(guildId);
  }

  async setNickname(guildId, nickname) {
    const guild = this.requireGuild(guildId);
    guild.nickname = nickname;
    guild.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async setKnowledgePacks(guildId, packIds) {
    const guild = this.requireGuild(guildId);
    guild.knowledgePacks = [...new Set(packIds.map(String))].sort();
    guild.updatedAt = new Date().toISOString();
    await this.persist();
    return guild.knowledgePacks;
  }

  getKnowledgePacks(guildId) {
    return this.data.guilds[guildId]?.knowledgePacks || [];
  }

  async setOpenRouterKey(guildId, apiKey) {
    const guild = this.requireGuild(guildId);
    guild.openRouterKey = encryptSecret(apiKey, this.secret);
    guild.updatedAt = new Date().toISOString();
    await this.persist();
  }

  getOpenRouterKey(guildId) {
    const encrypted = this.data.guilds[guildId]?.openRouterKey;
    return encrypted ? decryptSecret(encrypted, this.secret) : "";
  }

  async incrementTrial(guildId) {
    const guild = this.requireGuild(guildId);
    guild.trialUsed += 1;
    guild.updatedAt = new Date().toISOString();
    await this.persist();
    return guild.trialUsed;
  }

  getMonthlyUsage(guildId) {
    const guild = this.requireGuild(guildId);
    const month = currentMonth();
    if (guild.usage.month !== month) return { month, cost: 0 };
    return structuredClone(guild.usage);
  }

  async addUsageCost(guildId, cost) {
    if (!Number.isFinite(cost) || cost < 0) return;
    const guild = this.requireGuild(guildId);
    const month = currentMonth();
    if (guild.usage.month !== month) guild.usage = { month, cost: 0 };
    guild.usage.cost += cost;
    guild.updatedAt = new Date().toISOString();
    await this.persist();
  }

  getDailyPremiumUsage(guildId, packId, at = new Date()) {
    const guild = this.requireGuild(guildId);
    const day = utcDay(at);
    const usage = guild.dailyPremiumUsage?.[packId];
    const used = usage?.day === day ? Number(usage.used) || 0 : 0;
    return { day, used: Math.max(0, Math.floor(used)) };
  }

  async incrementDailyPremiumUsage(guildId, packId, at = new Date()) {
    const guild = this.requireGuild(guildId);
    const usage = this.getDailyPremiumUsage(guildId, packId, at);
    if (!guild.dailyPremiumUsage || typeof guild.dailyPremiumUsage !== "object") {
      guild.dailyPremiumUsage = {};
    }
    guild.dailyPremiumUsage[packId] = { day: usage.day, used: usage.used + 1 };
    guild.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(guild.dailyPremiumUsage[packId]);
  }

  requireGuild(guildId) {
    const guild = this.data.guilds[guildId];
    if (!guild) throw new Error(`Guild ${guildId} is not configured`);
    return guild;
  }

  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const write = this.writeQueue.then(async () => {
      await writeFile(temporaryPath, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }
}
