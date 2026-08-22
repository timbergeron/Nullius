import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionsBitField } from "discord.js";
import {
  createPkcePair,
  parseCookies,
  randomToken,
  sealSession,
  serializeCookie,
  unsealSession,
} from "./security.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(directory, "../public");
const SESSION_COOKIE = "nullius_session";
const DISCORD_STATE_COOKIE = "nullius_discord_state";
const OPENROUTER_STATE_COOKIE = "nullius_openrouter_state";
const OPENROUTER_VERIFIER_COOKIE = "nullius_openrouter_verifier";

function cookieOptions(config, maxAge) {
  return {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "Lax",
    secure: config.publicUrl.startsWith("https://"),
  };
}

function clearCookie(name, config) {
  return serializeCookie(name, "", cookieOptions(config, 0));
}

function sessionFromRequest(req, config) {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return unsealSession(value, config.appSecret);
}

function publicPath(config, pathname = "") {
  const basePath = new URL(config.publicUrl).pathname.replace(/\/$/, "");
  return `${basePath}/${pathname}`.replace(/\/+/g, "/");
}

function redirectWithError(res, config, code) {
  res.redirect(`${publicPath(config)}?error=${encodeURIComponent(code)}`);
}

async function discordApi(pathname, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || "Discord request failed");
  return body;
}

async function fetchGuild(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch().catch(() => {});
  return guild;
}

function bestChannel(guild) {
  const me = guild.members.me;
  if (!me) return null;
  const candidates = [...guild.channels.cache.values()]
    .filter((channel) => channel.isTextBased() && !channel.isThread())
    .filter((channel) => {
      const permissions = channel.permissionsFor(me);
      return permissions?.has(PermissionsBitField.Flags.ViewChannel) &&
        permissions.has(PermissionsBitField.Flags.SendMessages);
    })
    .sort((a, b) => a.rawPosition - b.rawPosition);
  return candidates.find((channel) => channel.id === guild.systemChannelId) || candidates[0] || null;
}

function publicKnowledge(knowledge, guildConfig) {
  const enabled = new Set(guildConfig.knowledgePacks || []);
  return (knowledge?.list() || []).map((pack) => ({
    ...pack,
    enabled: enabled.has(pack.id),
  }));
}

function publicGuildConfig(guildConfig, config) {
  const usage = guildConfig.usage?.month === new Date().toISOString().slice(0, 7)
    ? guildConfig.usage.cost
    : 0;
  return {
    openRouterConnected: Boolean(guildConfig.openRouterKey),
    trialRemaining: Math.max(0, config.openRouter.trialLimit - guildConfig.trialUsed),
    trialEnabled: Boolean(config.openRouter.trialApiKey),
    monthlyLimitUsd: guildConfig.monthlyLimitUsd,
    monthlyUsageUsd: usage,
  };
}

export function createWebApp({ config, store, client, openRouter, knowledge = null, logger = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
      res.set("Cache-Control", "no-store");
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, discord: client.isReady() });
  });

  app.get("/auth/discord", (_req, res) => {
    const state = randomToken();
    res.append("Set-Cookie", serializeCookie(
      DISCORD_STATE_COOKIE,
      state,
      cookieOptions(config, 10 * 60),
    ));

    const permissions = new PermissionsBitField([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.SendMessagesInThreads,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.ChangeNickname,
    ]).bitfield.toString();
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: config.discord.clientId,
      redirect_uri: config.discord.callbackUrl,
      response_type: "code",
      scope: "bot identify",
      permissions,
      integration_type: "0",
      prompt: "consent",
      state,
    });
    res.redirect(url.toString());
  });

  app.get("/auth/discord/callback", async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      if (!req.query.state || req.query.state !== cookies[DISCORD_STATE_COOKIE]) {
        return redirectWithError(res, config, "discord-state");
      }
      if (req.query.error || !req.query.code) {
        return redirectWithError(res, config, "discord-cancelled");
      }

      const token = await discordApi("/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: config.discord.callbackUrl,
        }),
      });
      const user = await discordApi("/users/@me", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const guildId = String(req.query.guild_id || token.guild?.id || "");
      if (!guildId) return redirectWithError(res, config, "missing-server");
      await fetchGuild(client, guildId);
      await store.ensureGuild({
        guildId,
        ownerId: user.id,
        monthlyLimitUsd: config.openRouter.monthlyLimitUsd,
      });

      const session = sealSession(
        { userId: user.id, guildId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 },
        config.appSecret,
      );
      res.append("Set-Cookie", clearCookie(DISCORD_STATE_COOKIE, config));
      res.append("Set-Cookie", serializeCookie(
        SESSION_COOKIE,
        session,
        cookieOptions(config, 30 * 24 * 60 * 60),
      ));
      res.redirect(`${publicPath(config)}?installed=1`);
    } catch (error) {
      logger.error("Discord OAuth failed", error);
      redirectWithError(res, config, "discord");
    }
  });

  app.get("/auth/openrouter", (req, res) => {
    const session = sessionFromRequest(req, config);
    if (!session) return res.redirect(publicPath(config, "auth/discord"));

    const state = randomToken();
    const { verifier, challenge } = createPkcePair();
    res.append("Set-Cookie", serializeCookie(
      OPENROUTER_STATE_COOKIE,
      state,
      cookieOptions(config, 10 * 60),
    ));
    res.append("Set-Cookie", serializeCookie(
      OPENROUTER_VERIFIER_COOKIE,
      verifier,
      cookieOptions(config, 10 * 60),
    ));
    const url = new URL("https://openrouter.ai/auth");
    url.search = new URLSearchParams({
      callback_url: config.openRouter.callbackUrl,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    res.redirect(url.toString());
  });

  app.get("/auth/openrouter/callback", async (req, res) => {
    try {
      const session = sessionFromRequest(req, config);
      const cookies = parseCookies(req.headers.cookie);
      if (!session) return res.redirect(publicPath(config, "auth/discord"));
      if (req.query.state && req.query.state !== cookies[OPENROUTER_STATE_COOKIE]) {
        return redirectWithError(res, config, "openrouter-state");
      }
      if (req.query.error || !req.query.code || !cookies[OPENROUTER_VERIFIER_COOKIE]) {
        return redirectWithError(res, config, "openrouter-cancelled");
      }
      const guildConfig = store.getGuild(session.guildId);
      if (!guildConfig || guildConfig.ownerId !== session.userId) {
        return redirectWithError(res, config, "session");
      }

      const key = await openRouter.exchangeOAuthCode({
        code: String(req.query.code),
        verifier: cookies[OPENROUTER_VERIFIER_COOKIE],
      });
      await openRouter.validateKey(key);
      await store.setOpenRouterKey(session.guildId, key);
      res.append("Set-Cookie", clearCookie(OPENROUTER_STATE_COOKIE, config));
      res.append("Set-Cookie", clearCookie(OPENROUTER_VERIFIER_COOKIE, config));
      res.redirect(`${publicPath(config)}?openrouter=connected`);
    } catch (error) {
      logger.error("OpenRouter OAuth failed", error);
      redirectWithError(res, config, "openrouter");
    }
  });

  app.get("/api/session", async (req, res) => {
    const session = sessionFromRequest(req, config);
    if (!session) {
      return res.json({
        authenticated: false,
        trialEnabled: Boolean(config.openRouter.trialApiKey),
        trialLimit: config.openRouter.trialLimit,
      });
    }
    const guildConfig = store.getGuild(session.guildId);
    if (!guildConfig || guildConfig.ownerId !== session.userId) {
      return res.json({
        authenticated: false,
        trialEnabled: Boolean(config.openRouter.trialApiKey),
        trialLimit: config.openRouter.trialLimit,
      });
    }
    try {
      const guild = await fetchGuild(client, session.guildId);
      const channel = bestChannel(guild);
      return res.json({
        authenticated: true,
        clientId: config.discord.clientId,
        guild: {
          id: guild.id,
          name: guild.name,
          iconUrl: guild.iconURL({ size: 128 }),
          nickname: guild.members.me?.nickname || "",
          channelUrl: channel
            ? `https://discord.com/channels/${guild.id}/${channel.id}`
            : `https://discord.com/channels/${guild.id}`,
        },
        ...publicGuildConfig(guildConfig, config),
        knowledgePacks: publicKnowledge(knowledge, guildConfig),
      });
    } catch (error) {
      logger.error("Could not load guild for session", error);
      return res.status(409).json({ authenticated: false, error: "server-unavailable" });
    }
  });

  app.post("/api/nickname", async (req, res) => {
    const session = sessionFromRequest(req, config);
    const guildConfig = session && store.getGuild(session.guildId);
    if (!session || !guildConfig || guildConfig.ownerId !== session.userId) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const nickname = String(req.body?.nickname || "").trim();
    if (nickname.length > 32) return res.status(400).json({ error: "too-long" });
    try {
      const guild = await fetchGuild(client, session.guildId);
      await guild.members.me.setNickname(nickname || null, "Configured through Nullius");
      await store.setNickname(session.guildId, nickname);
      return res.json({ ok: true, nickname });
    } catch (error) {
      logger.error("Could not change nickname", error);
      return res.status(400).json({ error: "nickname-failed" });
    }
  });

  app.post("/api/knowledge", async (req, res) => {
    const session = sessionFromRequest(req, config);
    const guildConfig = session && store.getGuild(session.guildId);
    if (!session || !guildConfig || guildConfig.ownerId !== session.userId) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const requested = req.body?.packIds;
    if (!Array.isArray(requested) || requested.length > 20) {
      return res.status(400).json({ error: "invalid-packs" });
    }
    const installed = new Set(
      (knowledge?.list() || []).filter((pack) => pack.ready).map((pack) => pack.id),
    );
    const packIds = requested.filter((packId) => installed.has(packId));
    if (packIds.length !== requested.length) {
      return res.status(400).json({ error: "unknown-pack" });
    }
    try {
      await store.setKnowledgePacks(session.guildId, packIds);
      return res.json({ ok: true, packIds });
    } catch (error) {
      logger.error("Could not save knowledge packs", error);
      return res.status(400).json({ error: "knowledge-failed" });
    }
  });

  app.use(express.static(publicDirectory, { extensions: ["html"], maxAge: "1h" }));
  return app;
}
