import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadMonolithConfig } from "../config.js";
import { LocalFileStorage } from "../storage/localFileStorage.js";
import type { GarmentGender } from "../types.js";
import { loadEnvFile } from "../utils/env.js";
import { createLogger } from "../utils/logger.js";
import { MonolithCatalog } from "./catalog.js";
import { walkTsumCatalogUrl, type TsumCatalogPageBatch } from "./providers/tsum/parser.js";
import { LocalCatalogStore } from "./store.js";

interface SourceCheckpoint {
  sourceUrl: string;
  gender: GarmentGender;
  lastCompletedPage: number;
  pageLimit?: number;
  discoveredPages?: number;
  savedItems: number;
  downloadedImages: number;
  reusedImages: number;
  failedImages: number;
  completed: boolean;
  updatedAt: string;
}

interface SlowIngestCheckpoint {
  version: 1;
  startedAt: string;
  updatedAt: string;
  sources: Record<string, SourceCheckpoint>;
}

loadEnvFile();

const logger = createLogger("monolith");
const config = loadMonolithConfig({ requireTelegramToken: false });
const storage = new LocalFileStorage(config.storageRoot);
const store = new LocalCatalogStore(config);
const catalog = new MonolithCatalog(config, store, storage);

const sourceUrls = readStringList(
  "MONOLITH_TSUM_SLOW_MALE_URLS",
  readString("MONOLITH_CATALOG_TSUM_MALE_URLS", "https://www.tsum.ru/catalog/odezhda-2409/"),
);
const checkpointPath = resolve(readString(
  "MONOLITH_TSUM_SLOW_CHECKPOINT_PATH",
  join(config.storageRoot, "catalog", "tsum-male-ingest-checkpoint.json"),
));
const resetCheckpoint = readBoolean("MONOLITH_TSUM_SLOW_RESET", false);

config.catalog.batchSize = readNonNegativeNumber("MONOLITH_TSUM_SLOW_BATCH_SIZE", 0);
config.catalog.tsumMaxPages = readNonNegativeNumber("MONOLITH_TSUM_SLOW_MAX_PAGES", 0);
config.catalog.tsumPageDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_PAGE_DELAY_MS", 2_500);
config.catalog.tsumPageRetryAttempts = readNumber("MONOLITH_TSUM_SLOW_PAGE_RETRY_ATTEMPTS", 5);
config.catalog.tsumRetryDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_RETRY_DELAY_MS", 10_000);
config.catalog.tsumProgressLogEveryPages = readNumber("MONOLITH_TSUM_SLOW_PROGRESS_EVERY_PAGES", 5);
config.catalog.imageDownloadConcurrency = readNumber("MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_CONCURRENCY", 1);
config.catalog.imageDownloadDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_DELAY_MS", 250);
config.catalog.downloadImagesOnRefresh = true;

void main().catch((error) => {
  logger.error("Slow TSUM male ingest crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (sourceUrls.length === 0) {
    throw new Error("No TSUM male catalog URLs configured");
  }

  await store.load();

  const checkpoint = resetCheckpoint
    ? createCheckpoint()
    : await readCheckpoint(checkpointPath);

  logger.info("Slow TSUM male ingest started", {
    urls: sourceUrls,
    checkpointPath,
    cachePath: config.catalog.cachePath,
    storageRoot: config.storageRoot,
    pageDelayMs: config.catalog.tsumPageDelayMs,
    retryAttempts: config.catalog.tsumPageRetryAttempts,
    retryDelayMs: config.catalog.tsumRetryDelayMs,
    maxPages: config.catalog.tsumMaxPages || "all",
    imageDownloadConcurrency: config.catalog.imageDownloadConcurrency,
    imageDownloadDelayMs: config.catalog.imageDownloadDelayMs,
  });

  for (const sourceUrl of sourceUrls) {
    const key = sourceKey("male", sourceUrl);
    const sourceCheckpoint = checkpoint.sources[key];

    if (sourceCheckpoint?.completed && !resetCheckpoint) {
      logger.info("Slow TSUM male ingest source already completed", {
        sourceUrl,
        lastCompletedPage: sourceCheckpoint.lastCompletedPage,
        pageLimit: sourceCheckpoint.pageLimit,
        savedItems: sourceCheckpoint.savedItems,
      });
      continue;
    }

    const startPage = Math.max(1, (sourceCheckpoint?.lastCompletedPage ?? 0) + 1);

    try {
      await walkTsumCatalogUrl(sourceUrl, config, {
        gender: "male",
        startPage,
        stopOnPageError: true,
        onPage: async (batch) => savePageBatch(checkpoint, key, batch),
      });

      const completedAt = new Date().toISOString();
      checkpoint.sources[key] = {
        ...createSourceCheckpoint(sourceUrl, "male"),
        ...checkpoint.sources[key],
        completed: true,
        updatedAt: completedAt,
      };
      checkpoint.updatedAt = completedAt;
      await writeCheckpoint(checkpointPath, checkpoint);

      logger.info("Slow TSUM male ingest source completed", {
        sourceUrl,
        lastCompletedPage: checkpoint.sources[key].lastCompletedPage,
        pageLimit: checkpoint.sources[key].pageLimit,
        savedItems: checkpoint.sources[key].savedItems,
      });
    } catch (error) {
      logger.error("Slow TSUM male ingest stopped; rerun command to continue", {
        sourceUrl,
        startPage,
        checkpointPath,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
      break;
    }
  }

  logger.info("Slow TSUM male ingest finished", {
    totalItems: store.list().length,
    checkpointPath,
    cachePath: config.catalog.cachePath,
  });
}

async function savePageBatch(
  checkpoint: SlowIngestCheckpoint,
  key: string,
  batch: TsumCatalogPageBatch,
): Promise<void> {
  const result = await catalog.upsertParsedItems(batch.items, {
    downloadImages: true,
    logImageSummary: false,
    logImageProgress: false,
  });
  const now = new Date().toISOString();
  const previous = checkpoint.sources[key] ?? createSourceCheckpoint(batch.sourceUrl, "male");

  checkpoint.sources[key] = {
    ...previous,
    sourceUrl: batch.sourceUrl,
    gender: "male",
    lastCompletedPage: batch.pageNumber,
    pageLimit: batch.pageLimit,
    discoveredPages: batch.discoveredPages,
    savedItems: previous.savedItems + result.items.length,
    downloadedImages: previous.downloadedImages + result.downloaded,
    reusedImages: previous.reusedImages + result.reused,
    failedImages: previous.failedImages + result.failed,
    completed: batch.pageNumber >= batch.pageLimit,
    updatedAt: now,
  };
  checkpoint.updatedAt = now;
  await writeCheckpoint(checkpointPath, checkpoint);

  if (
    batch.pageNumber === 1 ||
    batch.pageNumber % config.catalog.tsumProgressLogEveryPages === 0 ||
    batch.pageNumber >= batch.pageLimit
  ) {
    logger.info("Slow TSUM male ingest progress", {
      sourceUrl: batch.sourceUrl,
      page: batch.pageNumber,
      pageLimit: batch.pageLimit,
      pageItems: batch.items.length,
      savedItems: checkpoint.sources[key].savedItems,
      downloadedImages: checkpoint.sources[key].downloadedImages,
      reusedImages: checkpoint.sources[key].reusedImages,
      failedImages: checkpoint.sources[key].failedImages,
      totalItems: store.list().length,
    });
  }
}

function createCheckpoint(): SlowIngestCheckpoint {
  const now = new Date().toISOString();

  return {
    version: 1,
    startedAt: now,
    updatedAt: now,
    sources: {},
  };
}

function createSourceCheckpoint(sourceUrl: string, gender: GarmentGender): SourceCheckpoint {
  const now = new Date().toISOString();

  return {
    sourceUrl,
    gender,
    lastCompletedPage: 0,
    savedItems: 0,
    downloadedImages: 0,
    reusedImages: 0,
    failedImages: 0,
    completed: false,
    updatedAt: now,
  };
}

async function readCheckpoint(filePath: string): Promise<SlowIngestCheckpoint> {
  if (!existsSync(filePath)) {
    return createCheckpoint();
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<SlowIngestCheckpoint>;

  if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== "object") {
    throw new Error("Slow TSUM checkpoint has unsupported format");
  }

  return {
    version: 1,
    startedAt: parsed.startedAt ?? new Date().toISOString(),
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    sources: parsed.sources as Record<string, SourceCheckpoint>,
  };
}

async function writeCheckpoint(
  filePath: string,
  checkpoint: SlowIngestCheckpoint,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function sourceKey(gender: GarmentGender, sourceUrl: string): string {
  return `${gender}:${normalizeUrl(sourceUrl)}`;
}

function normalizeUrl(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).toString();
  } catch {
    return sourceUrl;
  }
}

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readStringList(name: string, fallback: string): string[] {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : raw;

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(name + " must be a positive number");
  }

  return value;
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(name + " must be a non-negative number");
  }

  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }

  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }

  throw new Error(name + " must be a boolean");
}