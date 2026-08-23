import path from "node:path";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, name, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be zero or a positive number`);
  }
  return Math.min(Math.floor(parsed), maximum);
}

export function loadConfig(env = process.env) {
  const appSecret = required(env, "APP_SECRET");
  if (appSecret.length < 32) {
    throw new Error("APP_SECRET must contain at least 32 characters");
  }

  const publicUrl = (env.PUBLIC_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");

  return {
    appSecret,
    publicUrl,
    port: Math.floor(positiveNumber(env.PORT, 3000, "PORT")),
    dataFile: path.resolve(env.DATA_FILE?.trim() || "./data/store.json"),
    discord: {
      clientId: required(env, "DISCORD_CLIENT_ID"),
      clientSecret: required(env, "DISCORD_CLIENT_SECRET"),
      token: required(env, "DISCORD_BOT_TOKEN"),
      callbackUrl: `${publicUrl}/auth/discord/callback`,
    },
    openRouter: {
      callbackUrl: `${publicUrl}/auth/openrouter/callback`,
      trialApiKey: env.OPENROUTER_API_KEY?.trim() || "",
      model: env.OPENROUTER_MODEL?.trim() || "openrouter/auto",
      trialLimit: Math.floor(positiveNumber(env.TRIAL_ANSWER_LIMIT, 20, "TRIAL_ANSWER_LIMIT")),
      monthlyLimitUsd: positiveNumber(
        env.DEFAULT_MONTHLY_LIMIT_USD,
        5,
        "DEFAULT_MONTHLY_LIMIT_USD",
      ),
      maxOutputTokens: Math.floor(
        positiveNumber(env.MAX_OUTPUT_TOKENS, 1600, "MAX_OUTPUT_TOKENS"),
      ),
      retryOutputTokens: Math.floor(
        positiveNumber(env.MAX_RETRY_OUTPUT_TOKENS, 4096, "MAX_RETRY_OUTPUT_TOKENS"),
      ),
    },
    context: {
      recentMessages: nonNegativeInteger(
        env.CHANNEL_CONTEXT_MESSAGES,
        10,
        "CHANNEL_CONTEXT_MESSAGES",
        100,
      ),
      maxMessages: Math.floor(
        positiveNumber(env.MAX_CONTEXT_MESSAGES, 12, "MAX_CONTEXT_MESSAGES"),
      ),
      maxCharacters: Math.floor(
        positiveNumber(env.MAX_CONTEXT_CHARACTERS, 16000, "MAX_CONTEXT_CHARACTERS"),
      ),
    },
    knowledge: {
      enabled: env.KNOWLEDGE_ENABLED?.trim() !== "false",
      packsDirectory: path.resolve(env.KNOWLEDGE_PACKS_DIR?.trim() || "./knowledge-packs"),
      indexDirectory: path.resolve(env.KNOWLEDGE_INDEX_DIR?.trim() || "./data/knowledge"),
      maxResults: Math.floor(
        positiveNumber(env.KNOWLEDGE_MAX_RESULTS, 12, "KNOWLEDGE_MAX_RESULTS"),
      ),
      maxCharacters: Math.floor(
        positiveNumber(env.KNOWLEDGE_MAX_CHARACTERS, 16000, "KNOWLEDGE_MAX_CHARACTERS"),
      ),
    },
    userCooldownMs:
      positiveNumber(env.USER_COOLDOWN_SECONDS, 8, "USER_COOLDOWN_SECONDS") * 1000,
  };
}
