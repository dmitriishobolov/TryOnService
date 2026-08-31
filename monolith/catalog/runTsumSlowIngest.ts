import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadMonolithConfig, type MonolithTsumProductEnrichment } from "../config.js";
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

type SlowIngestMode = "male" | "female" | "all";
type SlowIngestProfile = "safe" | "fast";

interface SlowIngestProfileDefaults {
  pageDelayMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  progressEveryPages: number;
  productEnrichment: MonolithTsumProductEnrichment;
  productConcurrency: number;
  productPageDelayMs: number;
  productPageTimeoutMs: number;
  productPageRetryAttempts: number;
  productRetryDelayMs: number;
  imageDownloadConcurrency: number;
  imageDownloadDelayMs: number;
}

interface SlowTsumSource {
  sourceUrl: string;
  gender: GarmentGender;
}

const defaultMaleTsumUrl = "https://www.tsum.ru/catalog/odezhda-2409/";
const defaultFemaleTsumUrl = "https://www.tsum.ru/catalog/odezhda-18413/";

const profileDefaults: Record<SlowIngestProfile, SlowIngestProfileDefaults> = {
  safe: {
    pageDelayMs: 2_500,
    retryAttempts: 5,
    retryDelayMs: 10_000,
    progressEveryPages: 5,
    productEnrichment: "missing",
    productConcurrency: 1,
    productPageDelayMs: 1_000,
    productPageTimeoutMs: 15_000,
    productPageRetryAttempts: 2,
    productRetryDelayMs: 5_000,
    imageDownloadConcurrency: 1,
    imageDownloadDelayMs: 250,
  },
  fast: {
    pageDelayMs: 2_000,
    retryAttempts: 5,
    retryDelayMs: 5_000,
    progressEveryPages: 2,
    productEnrichment: "off",
    productConcurrency: 1,
    productPageDelayMs: 1_000,
    productPageTimeoutMs: 12_000,
    productPageRetryAttempts: 2,
    productRetryDelayMs: 3_000,
    imageDownloadConcurrency: 24,
    imageDownloadDelayMs: 0,
  },
};
loadEnvFile();

const logger = createLogger("monolith");
const config = loadMonolithConfig({ requireTelegramToken: false });
const storage = new LocalFileStorage(config.storageRoot);
const store = new LocalCatalogStore(config);
const catalog = new MonolithCatalog(config, store, storage);
const mode = readMode();
const profile = readProfile();
const defaults = profileDefaults[profile];
const sourceList = readSourceList(mode);
const checkpointPath = resolve(readString(
  "MONOLITH_TSUM_SLOW_CHECKPOINT_PATH",
  join(config.storageRoot, "catalog", checkpointFileNameFor(mode)),
));
const resetCheckpoint = readBoolean("MONOLITH_TSUM_SLOW_RESET", false);

config.catalog.batchSize = readNonNegativeNumber("MONOLITH_TSUM_SLOW_BATCH_SIZE", 0);
config.catalog.tsumMaxPages = readNonNegativeNumber("MONOLITH_TSUM_SLOW_MAX_PAGES", 0);
config.catalog.tsumPageDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_PAGE_DELAY_MS", defaults.pageDelayMs);
config.catalog.tsumPageRetryAttempts = readNumber("MONOLITH_TSUM_SLOW_PAGE_RETRY_ATTEMPTS", defaults.retryAttempts);
config.catalog.tsumRetryDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_RETRY_DELAY_MS", defaults.retryDelayMs);
config.catalog.tsumProgressLogEveryPages = readNumber("MONOLITH_TSUM_SLOW_PROGRESS_EVERY_PAGES", defaults.progressEveryPages);
config.catalog.tsumProductEnrichment = readTsumProductEnrichment("MONOLITH_TSUM_SLOW_PRODUCT_ENRICHMENT", defaults.productEnrichment);
config.catalog.tsumProductConcurrency = readProductConcurrency(defaults.productConcurrency);
config.catalog.tsumProductPageDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_PRODUCT_PAGE_DELAY_MS", defaults.productPageDelayMs);
config.catalog.tsumProductPageTimeoutMs = readNumber("MONOLITH_TSUM_SLOW_PRODUCT_PAGE_TIMEOUT_MS", defaults.productPageTimeoutMs);
config.catalog.tsumProductPageRetryAttempts = readNumber("MONOLITH_TSUM_SLOW_PRODUCT_PAGE_RETRY_ATTEMPTS", defaults.productPageRetryAttempts);
config.catalog.tsumProductRetryDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_PRODUCT_RETRY_DELAY_MS", defaults.productRetryDelayMs);
config.catalog.imageDownloadConcurrency = readNumber("MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_CONCURRENCY", defaults.imageDownloadConcurrency);
config.catalog.imageDownloadDelayMs = readNonNegativeNumber("MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_DELAY_MS", defaults.imageDownloadDelayMs);
config.catalog.downloadImagesOnRefresh = true;

void main().catch((error) => {
  logger.error("Slow TSUM ingest crashed", {
    mode,
    profile,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (sourceList.length === 0) {
    throw new Error("No TSUM catalog URLs configured for mode " + mode);
  }

  await store.load();

  const checkpoint = resetCheckpoint
    ? createCheckpoint()
    : await readCheckpoint(checkpointPath);

  logger.info("Slow TSUM ingest started", {
    mode,
    profile,
    sources: sourceList,
    checkpointPath,
    cachePath: config.catalog.cachePath,
    storageRoot: config.storageRoot,
    pageDelayMs: config.catalog.tsumPageDelayMs,
    retryAttempts: config.catalog.tsumPageRetryAttempts,
    retryDelayMs: config.catalog.tsumRetryDelayMs,
    maxPages: config.catalog.tsumMaxPages || "all",
    productEnrichment: config.catalog.tsumProductEnrichment,
    productConcurrency: config.catalog.tsumProductConcurrency,
    productPageDelayMs: config.catalog.tsumProductPageDelayMs,
    productPageTimeoutMs: config.catalog.tsumProductPageTimeoutMs,
    productPageRetryAttempts: config.catalog.tsumProductPageRetryAttempts,
    productRetryDelayMs: config.catalog.tsumProductRetryDelayMs,
    imageDownloadConcurrency: config.catalog.imageDownloadConcurrency,
    imageDownloadDelayMs: config.catalog.imageDownloadDelayMs,
  });

  for (const source of sourceList) {
    const key = sourceKey(source.gender, source.sourceUrl);
    const sourceCheckpoint = checkpoint.sources[key];

    if (sourceCheckpoint?.completed && !resetCheckpoint) {
      logger.info("Slow TSUM ingest source already completed", {
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
      await walkTsumCatalogUrl(source.sourceUrl, config, {
        gender: source.gender,
        startPage,
        stopOnPageError: true,
        productEnrichment: config.catalog.tsumProductEnrichment,
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

      logger.info("Slow TSUM ingest source completed", {
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
      logger.error("Slow TSUM ingest stopped; rerun command to continue", {
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

  logger.info("Slow TSUM ingest finished", {
    mode,
    totalItems: store.list().length,
    checkpointPath,
    cachePath: config.catalog.cachePath,
  });
}

async function savePageBatch(
  checkpoint: SlowIngestCheckpoint,
  key: string,
  gender: GarmentGender,
  batch: TsumCatalogPageBatch,
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
    batch.pageNumber % config.catalog.tsumProgressLogEveryPages === 0 ||
    batch.pageNumber >= batch.pageLimit
  ) {
    logger.info("Slow TSUM ingest progress", {
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

function readProfile(): SlowIngestProfile {
  const cliProfile = process.argv
    .find((arg) => arg.startsWith("--profile="))
    ?.slice("--profile=".length)
    .trim()
    .toLowerCase();
  const value = cliProfile || readString("MONOLITH_TSUM_SLOW_PROFILE", "safe").toLowerCase();

  if (value === "safe" || value === "fast") {
    return value;
  }

  throw new Error("MONOLITH_TSUM_SLOW_PROFILE or --profile must be safe or fast");
}

function readTsumProductEnrichment(
  name: string,
  fallback: MonolithTsumProductEnrichment,
): MonolithTsumProductEnrichment {
  const cliValue = process.argv
    .filter((arg) => arg.startsWith("--product-enrichment="))
    .at(-1)
    ?.slice("--product-enrichment=".length)
    .trim()
    .toLowerCase();
  const value = cliValue || readString(name, fallback).toLowerCase();

  if (value === "off" || value === "missing" || value === "all") {
    return value;
  }

  throw new Error(name + " or --product-enrichment must be off, missing or all");
}

function readProductConcurrency(fallback: number): number {
  const cliValue = process.argv
    .filter((arg) => arg.startsWith("--product-concurrency="))
    .at(-1)
    ?.slice("--product-concurrency=".length)
    .trim();

  if (cliValue) {
    const value = Number(cliValue);

    if (Number.isFinite(value) && value > 0) {
      return value;
    }

    throw new Error("--product-concurrency must be a positive number");
  }

  return readNumber("MONOLITH_TSUM_SLOW_PRODUCT_CONCURRENCY", fallback);
}

function readMode(): SlowIngestMode {
  const cliMode = process.argv
    .find((arg) => arg.startsWith("--mode="))
    ?.slice("--mode=".length)
    .trim()
    .toLowerCase();
  const legacyCliMode = process.argv.includes("--male")
    ? "male"
    : process.argv.includes("--female")
      ? "female"
      : undefined;
  const value = cliMode || legacyCliMode || readString("MONOLITH_TSUM_SLOW_MODE", "all").toLowerCase();

  if (value === "male" || value === "female" || value === "all") {
    return value;
  }

  throw new Error("MONOLITH_TSUM_SLOW_MODE or --mode must be male, female or all");
}

function readSourceList(currentMode: SlowIngestMode): SlowTsumSource[] {
  const sources: SlowTsumSource[] = [];

  if (currentMode === "male" || currentMode === "all") {
    const fallback = readString("MONOLITH_CATALOG_TSUM_MALE_URLS", defaultMaleTsumUrl);
    sources.push(...readStringList("MONOLITH_TSUM_SLOW_MALE_URLS", fallback)
      .map((sourceUrl) => ({ sourceUrl, gender: "male" as const })));
  }

  if (currentMode === "female" || currentMode === "all") {
    const fallback = readString("MONOLITH_CATALOG_TSUM_FEMALE_URLS", defaultFemaleTsumUrl);
    sources.push(...readStringList("MONOLITH_TSUM_SLOW_FEMALE_URLS", fallback)
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

function checkpointFileNameFor(currentMode: SlowIngestMode): string {
  return currentMode === "all"
    ? "tsum-all-ingest-checkpoint.json"
    : "tsum-" + currentMode + "-ingest-checkpoint.json";
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
