import type { Server } from "node:http";
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";

import { loadEnvFile } from "../shared/env.js";
import { findAvailablePort } from "../shared/net.js";
import { LocalObjectStorage } from "../shared/storage/index.js";
import { StorageCoordinatorClient } from "./api/coordinatorClient.js";
import { createStorageServer } from "./api/server.js";
import { loadStorageConfig } from "./config/index.js";

loadEnvFile();

const config = loadStorageConfig();
const selectedPort = await findAvailablePort(config.port);

if (selectedPort !== config.port) {
  console.warn(
    `[storage] Port ${config.port} is busy, using free port ${selectedPort}`,
  );
  config.port = selectedPort;
  config.localUrl = `http://localhost:${selectedPort}`;
}

if (config.driver !== "local") {
  throw new Error("Only STORAGE_DRIVER=local is implemented for storage-node");
}

const localRoot = resolve(process.cwd(), config.localRoot);
const objects = new LocalObjectStorage({
  rootDir: localRoot,
});
const coordinator = new StorageCoordinatorClient(config);
let isRegistered = false;

const server = createStorageServer({
  config,
  objects,
  getUsedBytes: () => getDirectorySize(localRoot),
});

await listen(server, config.port);

console.log(`[storage] Listening on ${config.localUrl}`);

if (config.publicUrl) {
  console.log(`[storage] Public URL override: ${config.publicUrl}`);
} else {
  console.log("[storage] Public URL will be inferred by coordinator");
}

await registerStorage();

setInterval(() => {
  if (!isRegistered) {
    void registerStorage();
    return;
  }

  void getDirectorySize(localRoot)
    .then((usedBytes) => coordinator.heartbeat(usedBytes))
    .catch((error) => {
      isRegistered = false;
      console.error("[storage] Failed to send heartbeat", error);
    });
}, config.heartbeatIntervalMs);

async function registerStorage(): Promise<void> {
  try {
    const registration = await coordinator.register();
    isRegistered = true;
    console.log(
      `[storage] Registered in coordinator as ${registration.storageId}; heartbeat every ${registration.heartbeatIntervalMs}ms`,
    );
  } catch (error) {
    isRegistered = false;
    console.error("[storage] Failed to register in coordinator", error);
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

async function getDirectorySize(path: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];

  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = join(path, entry.name);

    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath);
      continue;
    }

    if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }

  return total;
}
