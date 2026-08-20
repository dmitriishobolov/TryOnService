import { resolve } from "node:path";

import {
  LocalObjectStorage,
  type ObjectStorage,
} from "../../shared/storage/index.js";
import type { CoordinatorConfig } from "../config/index.js";

export function createCoordinatorStorage(config: CoordinatorConfig): ObjectStorage {
  if (config.storageDriver === "local") {
    return new LocalObjectStorage({
      rootDir: resolve(process.cwd(), config.storageLocalRoot),
      publicBaseUrl: config.storagePublicBaseUrl,
    });
  }

  throw new Error(
    "S3 storage backend is not implemented yet. Use STORAGE_DRIVER=local for now.",
  );
}
