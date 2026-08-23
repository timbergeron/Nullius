import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { OpenRouterClient } from "./openrouter.js";
import { KnowledgeManager } from "./knowledge/manager.js";
import { FileStore } from "./store.js";
import { createWebApp } from "./web.js";

async function main() {
  const config = loadConfig();
  const store = new FileStore(config.dataFile, config.appSecret);
  await store.init();

  const openRouter = new OpenRouterClient({
    model: config.openRouter.model,
    maxOutputTokens: config.openRouter.maxOutputTokens,
    retryOutputTokens: config.openRouter.retryOutputTokens,
    publicUrl: config.publicUrl,
  });
  const knowledge = await new KnowledgeManager({
    packsDirectory: config.knowledge.packsDirectory,
    indexDirectory: config.knowledge.indexDirectory,
    enabled: config.knowledge.enabled,
    maxResults: config.knowledge.maxResults,
    maxCharacters: config.knowledge.maxCharacters,
  }).init();

  const client = createBot({ config, store, openRouter, knowledge });
  await client.login(config.discord.token);

  const app = createWebApp({ config, store, client, openRouter, knowledge });
  const server = app.listen(config.port, () => {
    console.info(`Nullius setup is available at ${config.publicUrl}`);
  });

  const shutdown = () => {
    server.close(() => {
      knowledge.close();
      client.destroy();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
