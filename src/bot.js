import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";
import {
  buildLlmMessages,
  collectConversationContext,
  stripBotMention,
} from "./context.js";
import {
  availablePremiumReviewModel,
  completeAnswer,
  knowledgeModelOverride,
  knowledgeUsesPack,
} from "./answer.js";
import { OpenRouterError } from "./openrouter.js";
import { RequestQueue } from "./queue.js";
import { maintainTyping } from "./typing.js";

function splitRawMessage(text, limit) {
  const parts = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < limit * 0.45) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    parts.push(remaining.slice(0, splitAt).trimEnd());
    let delimiterLength = 0;
    if (remaining.startsWith("\n\n", splitAt)) delimiterLength = 2;
    else if (["\n", " "].includes(remaining[splitAt])) delimiterLength = 1;
    remaining = remaining.slice(splitAt + delimiterLength);
  }
  if (remaining.trim()) parts.push(remaining.trimEnd());
  return parts;
}

function fenceStateAfter(text, initialLanguage) {
  let language = initialLanguage;
  for (const match of text.matchAll(/```([^\n`]*)/g)) {
    language = language === null ? match[1].trim().slice(0, 32) : null;
  }
  return language;
}

export function splitDiscordMessage(text, limit = 1900) {
  const contentLimit = Math.max(1, limit - 64);
  const rawParts = splitRawMessage(text, contentLimit);
  let openLanguage = null;
  return rawParts.map((part) => {
    const prefix = openLanguage === null ? "" : `\`\`\`${openLanguage}\n`;
    const nextOpenLanguage = fenceStateAfter(part, openLanguage);
    const suffix = nextOpenLanguage === null ? "" : "\n```";
    openLanguage = nextOpenLanguage;
    return `${prefix}${part}${suffix}`;
  });
}

async function replyWithoutPings(message, text) {
  const parts = splitDiscordMessage(text);
  if (!parts.length) return;
  await message.reply({
    content: parts[0],
    allowedMentions: { parse: [], repliedUser: false },
  });
  for (const part of parts.slice(1)) {
    await message.channel.send({ content: part, allowedMentions: { parse: [] } });
  }
}

// A contextual question is often just "@Nullius explain this", so a directly referenced
// message and the most recent conversation carry the terms worth searching for.
function retrievalQuery(context, question, botId) {
  const invocation = context.at(-1);
  const history = context.slice(0, -1);
  const referencedId = invocation?.reference?.messageId;
  const referenced = referencedId
    ? history.find((message) => message.id === referencedId)
    : null;
  const selected = new Map();
  for (const message of [referenced, ...history.slice(-4)]) {
    if (message?.id) selected.set(message.id, message);
  }
  const quoted = [...selected.values()]
    .map((message) => stripBotMention(message.content || "", botId).slice(0, 500))
    .filter(Boolean)
    .join("\n");
  return [question, quoted].filter(Boolean).join("\n");
}

export function createBot({ config, store, openRouter, knowledge = null, logger = console }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const cooldowns = new Map();

  client.once(Events.ClientReady, (readyClient) => {
    readyClient.user.setPresence({ status: "online" });
    logger.info(`Nullius is online as ${readyClient.user.tag}`);
  });

  async function answerMessage(message, question, queueMetadata = {}) {
    const startedAt = Date.now();
    const requestDetails = {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      queueWaitMs: Math.max(0, Number(queueMetadata.waitMs) || 0),
    };
    let outcome = "failed";
    let answerModel = "";
    let stopTyping = () => {};
    logger.info?.("Discord request started", requestDetails);
    try {
      const refreshedConfig = store.getGuild(message.guildId);
      const ownerKey = store.getOpenRouterKey(message.guildId);
      const usingTrial = !ownerKey;
      const apiKey = ownerKey || config.openRouter.trialApiKey;

      if (!apiKey || (usingTrial && refreshedConfig.trialUsed >= config.openRouter.trialLimit)) {
        outcome = "trial-unavailable";
        await replyWithoutPings(
          message,
          `The free answers are used up. A server admin can connect OpenRouter at ${config.publicUrl}`,
        );
        return;
      }

      if (!usingTrial) {
        const usage = store.getMonthlyUsage(message.guildId);
        if (usage.cost >= refreshedConfig.monthlyLimitUsd) {
          outcome = "monthly-limit";
          await replyWithoutPings(
            message,
            `This server reached its $${refreshedConfig.monthlyLimitUsd} monthly safety limit.`,
          );
          return;
        }
      }

      stopTyping = maintainTyping(message.channel);
      const context = await collectConversationContext(message, {
        recentMessages: config.context.recentMessages,
        maxReplyMessages: config.context.maxMessages,
        logger,
      });
      const retrieved = knowledge
        ? await knowledge.retrieve({
          packIds: refreshedConfig.knowledgePacks || [],
          question: retrievalQuery(context, question, client.user.id),
        })
        : null;
      if (retrieved) {
        logger.info?.(
          `Knowledge: ${retrieved.results.length} passages from ${
            retrieved.packs.map((pack) => pack.id).join(", ")
          }`,
        );
      }
      const messages = buildLlmMessages(context, {
        botId: client.user.id,
        maxCharacters: config.context.maxCharacters,
        knowledge: retrieved,
      });
      const rootMessageId = context[0]?.id || message.id;
      const qssmPremium = config.openRouter.packPremium.qssm;
      const qssmPremiumUsage = knowledgeUsesPack(retrieved, "qssm")
        ? store.getDailyPremiumUsage(message.guildId, "qssm")
        : null;
      const premiumReviewModel = availablePremiumReviewModel(
        retrieved,
        "qssm",
        qssmPremium,
        qssmPremiumUsage,
      );
      const answer = await completeAnswer({
        openRouter,
        apiKey,
        messages,
        sessionId: `${message.guildId}:${rootMessageId}`,
        userId: message.author.id,
        model: knowledgeModelOverride(retrieved, config.openRouter.packModels),
        reviewModel: premiumReviewModel,
        adversarialReview: Boolean(retrieved?.packs?.length),
        logger,
      });
      answerModel = answer.model || "";

      if (premiumReviewModel && answer.reviewed) {
        await store.incrementDailyPremiumUsage(
          message.guildId,
          "qssm",
          qssmPremiumUsage.day,
        );
        logger.info?.(`Premium knowledge review: qssm via ${premiumReviewModel}`);
      }
      if (usingTrial) await store.incrementTrial(message.guildId);
      else await store.addUsageCost(message.guildId, answer.cost);
      await replyWithoutPings(message, answer.text);
      outcome = "answered";
    } catch (error) {
      logger.error("Failed to answer Discord message", {
        ...requestDetails,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        error,
      });
      let ownerKey = "";
      try {
        ownerKey = store.getOpenRouterKey(message.guildId);
      } catch {
        logger.error("Could not decrypt the server's OpenRouter key");
      }
      const credentialProblem = error instanceof OpenRouterError && [401, 402, 403].includes(error.status);
      const response = credentialProblem && ownerKey
        ? `I couldn’t use this server’s OpenRouter connection. An admin can reconnect it at ${config.publicUrl}`
        : "I hit a temporary problem. Try again in a moment.";
      await replyWithoutPings(message, response).catch(() => {});
    } finally {
      stopTyping();
      logger.info?.("Discord request finished", {
        ...requestDetails,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        outcome,
        model: answerModel || undefined,
      });
    }
  }

  const requestQueue = new RequestQueue({
    maxPending: config.queue.maxPending,
    maxAgeMs: config.queue.maxAgeMs,
    handle: ({ message, question }, metadata) => answerMessage(message, question, metadata),
    onExpired: ({ message }) => replyWithoutPings(
      message,
      "I couldn’t reach that queued request before it expired. Mention me again if you still need it.",
    ).catch(() => {}),
    logger,
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!client.user || message.author.bot || !message.guildId) return;
    if (!message.mentions.users.has(client.user.id)) return;

    const question = stripBotMention(message.content || "", client.user.id);
    if (!question && !message.reference?.messageId) {
      await replyWithoutPings(message, "Reply to something and ask me about it.").catch(() => {});
      return;
    }

    const guildConfig = store.getGuild(message.guildId);
    if (!guildConfig) {
      await replyWithoutPings(
        message,
        `A server admin needs to finish my setup first: ${config.publicUrl}`,
      ).catch(() => {});
      return;
    }

    const cooldownKey = `${message.guildId}:${message.author.id}`;
    const now = Date.now();
    const retryAt = cooldowns.get(cooldownKey) || 0;
    if (!requestQueue.isActive(message.guildId) && retryAt > now) {
      const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
      await replyWithoutPings(
        message,
        `Give me ${seconds} more second${seconds === 1 ? "" : "s"} before another request.`,
      ).catch(() => {});
      return;
    }

    const queued = requestQueue.enqueue(message.guildId, {
      message,
      question,
      userId: message.author.id,
    });
    if (queued.status === "started" || queued.status === "queued") {
      cooldowns.set(cooldownKey, now + config.userCooldownMs);
      if (cooldowns.size > 10_000) cooldowns.clear();
    }

    if (queued.status === "queued") {
      const noun = queued.position === 1 ? "request" : "requests";
      await replyWithoutPings(
        message,
        `Queued—${queued.position} ${noun} ahead of you.`,
      ).catch(() => {});
    } else if (queued.status === "duplicate") {
      await replyWithoutPings(
        message,
        "You already have a request waiting in the queue.",
      ).catch(() => {});
    } else if (queued.status === "full") {
      await replyWithoutPings(
        message,
        "The request queue is full right now. Try again shortly.",
      ).catch(() => {});
    }
  });

  return client;
}
