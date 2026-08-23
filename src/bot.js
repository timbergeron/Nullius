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
import { OpenRouterError } from "./openrouter.js";

function splitDiscordMessage(text, limit = 1900) {
  const parts = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
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
  const busyGuilds = new Set();

  client.once(Events.ClientReady, (readyClient) => {
    readyClient.user.setPresence({ status: "online" });
    logger.info(`Nullius is online as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!client.user || message.author.bot || !message.guildId) return;
    if (!message.mentions.users.has(client.user.id)) return;

    const question = stripBotMention(message.content || "", client.user.id);
    if (!question && !message.reference?.messageId) {
      await replyWithoutPings(message, "Reply to something and ask me about it.");
      return;
    }

    const guildConfig = store.getGuild(message.guildId);
    if (!guildConfig) {
      await replyWithoutPings(
        message,
        `A server admin needs to finish my setup first: ${config.publicUrl}`,
      );
      return;
    }

    const cooldownKey = `${message.guildId}:${message.author.id}`;
    const now = Date.now();
    if ((cooldowns.get(cooldownKey) || 0) > now) return;
    cooldowns.set(cooldownKey, now + config.userCooldownMs);
    if (cooldowns.size > 10_000) cooldowns.clear();

    if (busyGuilds.has(message.guildId)) {
      await replyWithoutPings(message, "One moment—I’m answering another question here.");
      return;
    }
    busyGuilds.add(message.guildId);

    try {
      const refreshedConfig = store.getGuild(message.guildId);
      const ownerKey = store.getOpenRouterKey(message.guildId);
      const usingTrial = !ownerKey;
      const apiKey = ownerKey || config.openRouter.trialApiKey;

      if (!apiKey || (usingTrial && refreshedConfig.trialUsed >= config.openRouter.trialLimit)) {
        await replyWithoutPings(
          message,
          `The free answers are used up. A server admin can connect OpenRouter at ${config.publicUrl}`,
        );
        return;
      }

      if (!usingTrial) {
        const usage = store.getMonthlyUsage(message.guildId);
        if (usage.cost >= refreshedConfig.monthlyLimitUsd) {
          await replyWithoutPings(
            message,
            `This server reached its $${refreshedConfig.monthlyLimitUsd} monthly safety limit.`,
          );
          return;
        }
      }

      await message.channel.sendTyping().catch(() => {});
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
      const answer = await openRouter.complete({
        apiKey,
        messages,
        sessionId: `${message.guildId}:${rootMessageId}`,
        userId: message.author.id,
      });

      if (usingTrial) await store.incrementTrial(message.guildId);
      else await store.addUsageCost(message.guildId, answer.cost);
      await replyWithoutPings(message, answer.text);
    } catch (error) {
      logger.error("Failed to answer Discord message", error);
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
      busyGuilds.delete(message.guildId);
    }
  });

  return client;
}
