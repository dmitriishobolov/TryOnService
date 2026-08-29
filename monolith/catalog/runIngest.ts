import { loadEnvFile } from ".././utils/env.js";
import { createLogger } from ".././utils/logger.js";
import { loadMonolithConfig } from "../config.js";
import { LocalFileStorage } from "../storage/localFileStorage.js";
import { MonolithCatalog } from "./catalog.js";
import { LocalCatalogStore } from "./store.js";

loadEnvFile();

const logger = createLogger("monolith");
const config = loadMonolithConfig({ requireTelegramToken: false });
const storage = new LocalFileStorage(config.storageRoot);
const store = new LocalCatalogStore(config);
const catalog = new MonolithCatalog(config, store, storage);
const items = await catalog.refresh();

logger.info("Monolith catalog ingest finished", {
  items: items.length,
  categories: store.categories(),
  cachePath: config.catalog.cachePath,
});

console.log(JSON.stringify(items.slice(0, 10), null, 2));
