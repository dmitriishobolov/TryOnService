import { loadEnvFile } from "../../shared/env.js";
import { findAvailablePort } from "../../shared/net.js";
import { TelegramBot } from "./bot.js";
import { createTelegramCallbackServer } from "./callbackServer.js";
import { loadTelegramClientConfig } from "./config.js";
import { TelegramCoordinatorClient } from "./coordinatorClient.js";
import type { Server } from "node:http";

loadEnvFile();

const config = loadTelegramClientConfig();
const selectedPort = await findAvailablePort(config.port);

if (selectedPort !== config.port) {
  console.warn(
    `[telegram] Port ${config.port} is busy, using free port ${selectedPort}`,
  );
  config.port = selectedPort;
  config.localUrl = `http://localhost:${selectedPort}`;
}

const coordinator = new TelegramCoordinatorClient(config);
const bot = new TelegramBot(config, coordinator);
const callbackServer = createTelegramCallbackServer(bot);
let isRegistered = false;

await listen(callbackServer, config.port);

console.log(`[telegram] Callback server listening on ${config.localUrl}`);

if (config.publicUrl) {
  console.log(`[telegram] Public URL override: ${config.publicUrl}`);
} else {
  console.log("[telegram] Public URL will be inferred by coordinator");
}

await registerClient();

setInterval(() => {
  if (!isRegistered) {
    void registerClient();
    return;
  }

  void coordinator.heartbeat().catch((error) => {
    isRegistered = false;
    console.error("[telegram] Failed to send heartbeat", error);
  });
}, config.heartbeatIntervalMs);

void bot.startPolling();

async function registerClient(): Promise<void> {
  try {
    const registration = await coordinator.register();
    isRegistered = true;
    console.log(
      `[telegram] Registered in coordinator as ${registration.clientId}; callback ${registration.callbackUrl}; heartbeat every ${registration.heartbeatIntervalMs}ms`,
    );
  } catch (error) {
    isRegistered = false;
    console.error("[telegram] Failed to register in coordinator", error);
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      resolve();
    });
  });
}
