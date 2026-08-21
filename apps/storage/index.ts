import type { Server } from "node:http";
import { resolve } from "node:path";

import { loadEnvFile } from "../shared/env.js";
import { findAvailablePort } from "../shared/net.js";
import {
  LocalObjectStorage,
  S3CompatibleObjectStorage,
  type ObjectStorage,
} from "../shared/storage/index.js";
import { StorageCoordinatorClient } from "./api/coordinatorClient.js";
import { createStorageServer } from "./api/server.js";
import { StorageCatalogIndex } from "./catalog/index.js";
import { loadStorageConfig, type StorageConfig } from "./config/index.js";

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

const objects = createObjectStorage(config);
const catalog = createStorageCatalog(config, objects);
const coordinator = new StorageCoordinatorClient(config);
let isRegistered = false;

const server = createStorageServer({
  config,
  objects,
  catalog,
  getUsedBytes: async () => objects.getUsedBytes(),
});

await listen(server, config.port);

console.log(`[storage] Listening on ${config.localUrl}`);
console.log(
  `[storage] Storage ID: ${config.storageId}${
    config.storageIdPath ? ` (${config.storageIdPath})` : ""
  }`,
);

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

  void Promise.resolve(objects.getUsedBytes())
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

function createObjectStorage(config: StorageConfig): ObjectStorage {
  const metadataPath = config.metadataPath
    ? resolve(process.cwd(), config.metadataPath)
    : undefined;

  if (config.driver === "local") {
    return new LocalObjectStorage({
      rootDir: resolve(process.cwd(), config.localRoot),
      metadataPath,
      publicBaseUrl: config.publicUrl
        ? `${config.publicUrl.replace(/\/$/, "")}/objects`
        : undefined,
    });
  }

  if (
    !config.s3Endpoint ||
    !config.s3Bucket ||
    !config.s3AccessKeyId ||
    !config.s3SecretAccessKey
  ) {
    throw new Error("S3 storage config is incomplete");
  }

  return new S3CompatibleObjectStorage({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    forcePathStyle: config.s3ForcePathStyle,
    metadataPath:
      metadataPath ??
      resolve(process.cwd(), config.localRoot, ".tryon-s3-storage-metadata.json"),
    publicBaseUrl: config.publicUrl
      ? `${config.publicUrl.replace(/\/$/, "")}/objects`
      : undefined,
  });
}

function createStorageCatalog(
  config: StorageConfig,
  objects: ObjectStorage,
): StorageCatalogIndex {
  const catalogPath = config.catalogPath
    ? resolve(process.cwd(), config.catalogPath)
    : resolve(process.cwd(), config.localRoot, ".tryon-storage-catalog.json");

  return new StorageCatalogIndex({
    catalogPath,
    storageId: config.storageId,
    objects,
  });
}
