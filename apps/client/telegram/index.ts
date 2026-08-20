import "dotenv/config";

import { TelegramBot } from "./bot.js";
import { createTelegramCallbackServer } from "./callbackServer.js";
import { loadTelegramClientConfig } from "./config.js";
import { TelegramCoordinatorClient } from "./coordinatorClient.js";

const config = loadTelegramClientConfig();
const coordinator = new TelegramCoordinatorClient(config);
const bot = new TelegramBot(config, coordinator);
const callbackServer = createTelegramCallbackServer(bot);

callbackServer.listen(config.port, () => {
  console.log(`[telegram] Callback server listening on ${config.publicUrl}`);
});

void bot.startPolling();
