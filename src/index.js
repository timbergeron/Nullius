import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { OpenRouterClient } from "./openrouter.js";
import { FileStore } from "./store.js";
import { createWebApp } from "./web.js";

async function main() {
  const config = loadConfig();
  const store = new FileStore(config.dataFile, config.appSecret);
  await store.init();

  const openRouter = new OpenRouterClient({
    model: config.openRouter.model,
    maxOutputTokens: config.openRouter.maxOutputTokens,
    publicUrl: config.publicUrl,
  });
  const client = createBot({ config, store, openRouter });
  await client.login(config.discord.token);

  const app = createWebApp({ config, store, client, openRouter });
  const server = app.listen(config.port, () => {
    console.info(`Nullius setup is available at ${config.publicUrl}`);
  });

  const shutdown = () => {
    server.close(() => {
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
