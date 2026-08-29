import { loadEnvFile } from './utils/env.js';
import { createLogger } from './utils/logger.js';
import { TelegramMonolithBot } from './bot/telegramBot.js';
import { MonolithCatalog } from './catalog/catalog.js';
import { LocalCatalogStore } from './catalog/store.js';
import { loadMonolithConfig } from './config.js';
import { OpenAiVisionService } from './providers/openaiVision.js';
import { createTryOnProvider } from './providers/tryOn.js';
import { LocalFileStorage } from './storage/localFileStorage.js';

loadEnvFile();

const logger = createLogger('monolith');
const config = loadMonolithConfig();
const storage = new LocalFileStorage(config.storageRoot);
const catalogStore = new LocalCatalogStore(config);
const catalog = new MonolithCatalog(config, catalogStore, storage);
const openai = new OpenAiVisionService(config);
const tryOn = createTryOnProvider(config);
const bot = new TelegramMonolithBot(config, storage, openai, tryOn, catalog);

if (config.catalog.refreshOnStart) {
  void catalog.refresh().catch((error) => {
    logger.error('Monolith catalog refresh on start failed', { error });
  });
}

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { error });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
});

await bot.startPolling();
