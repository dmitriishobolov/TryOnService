import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadMonolithConfig, type MonolithLamodaBrowserChannel, type MonolithLamodaProductEnrichment } from "../config.js";
import { LocalFileStorage } from "../storage/localFileStorage.js";
import type { GarmentGender } from "../types.js";
import { loadEnvFile } from "../utils/env.js";
import { createLogger } from "../utils/logger.js";
import { MonolithCatalog } from "./catalog.js";
import { walkLamodaCatalogUrl, type LamodaCatalogPageBatch } from "./providers/lamoda/parser.js";
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

interface LamodaIngestCheckpoint {
  version: 1;
  startedAt: string;
  updatedAt: string;
  sources: Record<string, SourceCheckpoint>;
}

type LamodaIngestMode = "male" | "female" | "all";

interface LamodaSource {
  sourceUrl: string;
  gender: GarmentGender;
}

const defaultMaleLamodaUrl = "https://www.lamoda.ru/c/477/clothes-muzhskaya-odezhda";
const defaultFemaleLamodaUrl = "https://www.lamoda.ru/c/355/clothes-zhenskaya-odezhda";

loadEnvFile();

const logger = createLogger("monolith");
const config = loadMonolithConfig({ requireTelegramToken: false });
const storage = new LocalFileStorage(config.storageRoot);
const store = new LocalCatalogStore(config);
const catalog = new MonolithCatalog(config, store, storage);
const mode = readMode();
const sourceList = readSourceList(mode);
const checkpointPath = resolve(readString(
  "MONOLITH_LAMODA_CHECKPOINT_PATH",
  join(config.storageRoot, "catalog", checkpointFileNameFor(mode)),
));
const resetCheckpoint = readBoolean("MONOLITH_LAMODA_RESET", false);

config.catalog.batchSize = readNonNegativeNumber("MONOLITH_LAMODA_BATCH_SIZE", 0);
config.catalog.lamodaMaxPages = readNonNegativeNumber("MONOLITH_LAMODA_MAX_PAGES", 0);
config.catalog.lamodaPageDelayMs = readNonNegativeNumber("MONOLITH_LAMODA_PAGE_DELAY_MS", 2_000);
config.catalog.lamodaPageRetryAttempts = readNumber("MONOLITH_LAMODA_PAGE_RETRY_ATTEMPTS", 3);
config.catalog.lamodaRetryDelayMs = readNonNegativeNumber("MONOLITH_LAMODA_RETRY_DELAY_MS", 5_000);
config.catalog.lamodaProgressLogEveryPages = readNumber("MONOLITH_LAMODA_PROGRESS_EVERY_PAGES", 5);
config.catalog.lamodaSecurityWaitMs = readNonNegativeNumber("MONOLITH_LAMODA_SECURITY_WAIT_MS", config.catalog.lamodaSecurityWaitMs);
config.catalog.lamodaUserDataDir = resolve(readString("MONOLITH_LAMODA_USER_DATA_DIR", config.catalog.lamodaUserDataDir));
config.catalog.browserHeadless = readBoolean("MONOLITH_LAMODA_BROWSER_HEADLESS", config.catalog.browserHeadless);
config.catalog.lamodaBrowserChannel = readLamodaBrowserChannel("MONOLITH_LAMODA_BROWSER_CHANNEL", config.catalog.lamodaBrowserChannel);
config.catalog.lamodaBrowserExecutablePath = readCliArg("browser-executable-path") ?? readOptionalString("MONOLITH_LAMODA_BROWSER_EXECUTABLE_PATH") ?? config.catalog.lamodaBrowserExecutablePath;
config.catalog.lamodaProductEnrichment = readLamodaProductEnrichment("MONOLITH_LAMODA_PRODUCT_ENRICHMENT", "missing");
config.catalog.lamodaProductConcurrency = readNumber("MONOLITH_LAMODA_PRODUCT_CONCURRENCY", 1);
config.catalog.lamodaProductPageDelayMs = readNonNegativeNumber("MONOLITH_LAMODA_PRODUCT_PAGE_DELAY_MS", 1_000);
config.catalog.lamodaProductPageTimeoutMs = readNumber("MONOLITH_LAMODA_PRODUCT_PAGE_TIMEOUT_MS", 20_000);
config.catalog.lamodaProductPageRetryAttempts = readNumber("MONOLITH_LAMODA_PRODUCT_PAGE_RETRY_ATTEMPTS", 2);
config.catalog.lamodaProductRetryDelayMs = readNonNegativeNumber("MONOLITH_LAMODA_PRODUCT_RETRY_DELAY_MS", 3_000);
config.catalog.imageDownloadConcurrency = readNumber("MONOLITH_LAMODA_IMAGE_DOWNLOAD_CONCURRENCY", 8);
config.catalog.imageDownloadDelayMs = readNonNegativeNumber("MONOLITH_LAMODA_IMAGE_DOWNLOAD_DELAY_MS", 0);
config.catalog.downloadImagesOnRefresh = true;

void main().catch((error) => {
  logger.error("Lamoda ingest crashed", {
    mode,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (sourceList.length === 0) {
    throw new Error("No Lamoda catalog URLs configured for mode " + mode);
  }

  await store.load();

  const checkpoint = resetCheckpoint
    ? createCheckpoint()
    : await readCheckpoint(checkpointPath);

  logger.info("Lamoda ingest started", {
    mode,
    sources: sourceList,
    checkpointPath,
    cachePath: config.catalog.cachePath,
    storageRoot: config.storageRoot,
    pageDelayMs: config.catalog.lamodaPageDelayMs,
    retryAttempts: config.catalog.lamodaPageRetryAttempts,
    retryDelayMs: config.catalog.lamodaRetryDelayMs,
    maxPages: config.catalog.lamodaMaxPages || "all",
    securityWaitMs: config.catalog.lamodaSecurityWaitMs,
    browserHeadless: config.catalog.browserHeadless,
    browserChannel: config.catalog.lamodaBrowserChannel,
    browserExecutablePath: config.catalog.lamodaBrowserExecutablePath,
    userDataDir: config.catalog.lamodaUserDataDir,
    productEnrichment: config.catalog.lamodaProductEnrichment,
    productConcurrency: config.catalog.lamodaProductConcurrency,
    productPageDelayMs: config.catalog.lamodaProductPageDelayMs,
    productPageTimeoutMs: config.catalog.lamodaProductPageTimeoutMs,
    productPageRetryAttempts: config.catalog.lamodaProductPageRetryAttempts,
    productRetryDelayMs: config.catalog.lamodaProductRetryDelayMs,
    imageDownloadConcurrency: config.catalog.imageDownloadConcurrency,
    imageDownloadDelayMs: config.catalog.imageDownloadDelayMs,
  });

  for (const source of sourceList) {
    const key = sourceKey(source.gender, source.sourceUrl);
    const sourceCheckpoint = checkpoint.sources[key];

    if (sourceCheckpoint?.completed && !resetCheckpoint) {
      logger.info("Lamoda ingest source already completed", {
        sourceUrl: source.sourceUrl,
        gender: source.gender,
        lastCompletedPage: sourceCheckpoint.lastCompletedPage,
        pageLimit: sourceCheckpoint.pageLimit,
        savedItems: sourceCheckpoint.savedItems,
        failedImages: sourceCheckpoint.failedImages,
      });
      continue;
    }

    const startPage = Math.max(1, (sourceCheckpoint?.lastCompletedPage ?? 0) + 1);

    try {
      await walkLamodaCatalogUrl(source.sourceUrl, config, {
        gender: source.gender,
        startPage,
        stopOnPageError: true,
        onPage: async (batch) => savePageBatch(checkpoint, key, source.gender, batch),
      });

      const completedAt = new Date().toISOString();
      checkpoint.sources[key] = {
        ...createSourceCheckpoint(source.sourceUrl, source.gender),
        ...checkpoint.sources[key],
        completed: true,
        updatedAt: completedAt,
      };
      checkpoint.updatedAt = completedAt;
      await writeCheckpoint(checkpointPath, checkpoint);

      logger.info("Lamoda ingest source completed", {
        sourceUrl: source.sourceUrl,
        gender: source.gender,
        lastCompletedPage: checkpoint.sources[key].lastCompletedPage,
        pageLimit: checkpoint.sources[key].pageLimit,
        savedItems: checkpoint.sources[key].savedItems,
        downloadedImages: checkpoint.sources[key].downloadedImages,
        reusedImages: checkpoint.sources[key].reusedImages,
        failedImages: checkpoint.sources[key].failedImages,
      });
    } catch (error) {
      logger.error("Lamoda ingest stopped; rerun command to continue", {
        sourceUrl: source.sourceUrl,
        gender: source.gender,
        startPage,
        checkpointPath,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
      break;
    }
  }

  logger.info("Lamoda ingest finished", {
    mode,
    totalItems: store.list().length,
    checkpointPath,
    cachePath: config.catalog.cachePath,
  });
}

async function savePageBatch(
  checkpoint: LamodaIngestCheckpoint,
  key: string,
  gender: GarmentGender,
  batch: LamodaCatalogPageBatch,
): Promise<void> {
  const result = await catalog.upsertParsedItems(batch.items, {
    downloadImages: true,
    logImageSummary: false,
    logImageProgress: false,
  });
  const now = new Date().toISOString();
  const previous = checkpoint.sources[key] ?? createSourceCheckpoint(batch.sourceUrl, gender);

  checkpoint.sources[key] = {
    ...previous,
    sourceUrl: batch.sourceUrl,
    gender,
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
    batch.pageNumber % config.catalog.lamodaProgressLogEveryPages === 0 ||
    batch.pageNumber >= batch.pageLimit
  ) {
    logger.info("Lamoda ingest progress", {
      sourceUrl: batch.sourceUrl,
      gender,
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

function readLamodaBrowserChannel(
  name: string,
  fallback: MonolithLamodaBrowserChannel,
): MonolithLamodaBrowserChannel {
  const cliValue = readCliArg("browser-channel");
  const value = (cliValue || readString(name, fallback)).toLowerCase();

  if (value === "chromium" || value === "chrome" || value === "msedge" || value === "opera") {
    return value;
  }

  throw new Error(name + " or --browser-channel must be chromium, chrome, msedge or opera");
}

function readLamodaProductEnrichment(
  name: string,
  fallback: MonolithLamodaProductEnrichment,
): MonolithLamodaProductEnrichment {
  const value = readString(name, fallback).toLowerCase();

  if (value === "off" || value === "missing" || value === "all") {
    return value;
  }

  throw new Error(name + " must be off, missing or all");
}

function readMode(): LamodaIngestMode {
  // CLI args intentionally override shell env so stale PowerShell variables do not leak into parser runs.
  const cliMode = process.argv
    .find((arg) => arg.startsWith("--mode="))
    ?.slice("--mode=".length)
    .trim()
    .toLowerCase();
  const value = cliMode || readString("MONOLITH_LAMODA_MODE", "all").toLowerCase();

  if (value === "male" || value === "female" || value === "all") {
    return value;
  }

  throw new Error("MONOLITH_LAMODA_MODE or --mode must be male, female or all");
}

function readSourceList(currentMode: LamodaIngestMode): LamodaSource[] {
  const sources: LamodaSource[] = [];

  if (currentMode === "male" || currentMode === "all") {
    const fallback = readString("MONOLITH_CATALOG_LAMODA_MALE_URLS", defaultMaleLamodaUrl);
    sources.push(...readStringList("MONOLITH_LAMODA_MALE_URLS", fallback)
      .map((sourceUrl) => ({ sourceUrl, gender: "male" as const })));
  }

  if (currentMode === "female" || currentMode === "all") {
    const fallback = readString("MONOLITH_CATALOG_LAMODA_FEMALE_URLS", defaultFemaleLamodaUrl);
    sources.push(...readStringList("MONOLITH_LAMODA_FEMALE_URLS", fallback)
      .map((sourceUrl) => ({ sourceUrl, gender: "female" as const })));
  }

  const seen = new Set<string>();

  return sources.filter((source) => {
    const key = sourceKey(source.gender, source.sourceUrl);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function checkpointFileNameFor(currentMode: LamodaIngestMode): string {
  return currentMode === "all"
    ? "lamoda-all-ingest-checkpoint.json"
    : "lamoda-" + currentMode + "-ingest-checkpoint.json";
}

function createCheckpoint(): LamodaIngestCheckpoint {
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

async function readCheckpoint(filePath: string): Promise<LamodaIngestCheckpoint> {
  if (!existsSync(filePath)) {
    return createCheckpoint();
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<LamodaIngestCheckpoint>;

  if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== "object") {
    throw new Error("Lamoda checkpoint has unsupported format");
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
  checkpoint: LamodaIngestCheckpoint,
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

function readCliArg(name: string): string | undefined {
  const prefix = "--" + name + "=";

  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() || undefined;
}

function readOptionalString(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function readStringList(name: string, fallback: string): string[] {
  const raw = process.env[name]?.trim();
  const value = raw || fallback;

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
