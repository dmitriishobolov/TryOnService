import type { Server } from "node:http";

import { loadEnvFile } from "../shared/env.js";
import { findAvailablePort } from "../shared/net.js";
import { CatalogCoordinatorClient } from "./api/coordinatorClient.js";
import { createCatalogIngestorServer } from "./api/server.js";
import { createCatalogProviders } from "./catalog/providers/index.js";
import { CatalogSyncRunner } from "./catalog/syncRunner.js";
import { GarmentCatalogPublisher } from "./catalog/storagePublisher.js";
import { loadCatalogIngestorConfig } from "./config/index.js";

loadEnvFile();

const config = loadCatalogIngestorConfig();
const selectedPort = await findAvailablePort(config.port);

if (selectedPort !== config.port) {
  console.warn(
    `[catalog-ingestor] Port ${config.port} is busy, using free port ${selectedPort}`,
  );
  config.port = selectedPort;
  config.localUrl = `http://localhost:${selectedPort}`;
}

const coordinator = new CatalogCoordinatorClient(config);
const server = createCatalogIngestorServer(config);
const providers = createCatalogProviders(config.providers);
const publisher = new GarmentCatalogPublisher(config, coordinator);
const runner = new CatalogSyncRunner(config, providers, publisher);
let isRegistered = false;

await listen(server, config.port);

console.log(`[catalog-ingestor] Health server listening on ${config.localUrl}`);

if (config.publicUrl) {
  console.log(`[catalog-ingestor] Public URL override: ${config.publicUrl}`);
} else {
  console.log("[catalog-ingestor] Public URL will be inferred by coordinator");
}

await registerClient();

setInterval(() => {
  if (!isRegistered) {
    void registerClient();
    return;
  }

  void coordinator.heartbeat().catch((error) => {
    isRegistered = false;
    console.error("[catalog-ingestor] Failed to send heartbeat", error);
  });
}, config.heartbeatIntervalMs);

runner.start();

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function registerClient(): Promise<void> {
  try {
    const registration = await coordinator.register();
    isRegistered = true;
    console.log(
      `[catalog-ingestor] Registered in coordinator as ${registration.clientId}; heartbeat every ${registration.heartbeatIntervalMs}ms`,
    );
  } catch (error) {
    isRegistered = false;
    console.error("[catalog-ingestor] Failed to register in coordinator", error);
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

function shutdown(reason: string): void {
  console.log(`[catalog-ingestor] Shutting down after ${reason}`);
  runner.stop();
  server.close(() => {
    process.exit(0);
  });
}