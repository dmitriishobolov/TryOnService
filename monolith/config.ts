import { resolve } from "node:path";

import type { GarmentGender } from "./types.js";

export type OpenAiImageDetail = "low" | "auto" | "high";
export type OpenAiTextVerbosity = "low" | "medium" | "high";
export type OpenAiReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type MonolithTryOnProvider = "mock" | "pruna";
export type MonolithCatalogProvider = "tsum";
export type MonolithBrowserWaitUntil = "load" | "domcontentloaded" | "networkidle";

export interface MonolithOpenAiConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  imageDetail: OpenAiImageDetail;
  textVerbosity: OpenAiTextVerbosity;
  reasoningEffort: OpenAiReasoningEffort;
  reasoningMode?: string;
  maxOutputTokens: number;
  storeResponse: boolean;
  organization?: string;
  project?: string;
  systemPrompt: string;
}

export interface MonolithPrunaConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  predictionPathTemplate: string;
  outputFormat: string;
  outputQuality?: number;
  preserveInputSize: boolean;
  prompt?: string;
  seed?: number;
  turbo: boolean;
}

export interface MonolithCatalogSource {
  provider: MonolithCatalogProvider;
  url: string;
  gender: GarmentGender;
}

export interface MonolithCatalogConfig {
  enabled: boolean;
  refreshOnStart: boolean;
  providers: MonolithCatalogProvider[];
  tsumSources: MonolithCatalogSource[];
  batchSize: number;
  tsumMaxPages: number;
  tsumPageDelayMs: number;
  tsumPageRetryAttempts: number;
  tsumRetryDelayMs: number;
  tsumProgressLogEveryPages: number;
  downloadImagesOnRefresh: boolean;
  imageDownloadConcurrency: number;
  imageDownloadDelayMs: number;
  candidatesPerCategory: number;
  cachePath: string;
  browserHeadless: boolean;
  browserTimeoutMs: number;
  browserWaitUntil: MonolithBrowserWaitUntil;
  userAgent: string;
}

export interface MonolithConfig {
  telegramBotToken: string;
  pollingTimeoutSeconds: number;
  storageRoot: string;
  maxDownloadBytes: number;
  httpTimeoutMs: number;
  tryOnProvider: MonolithTryOnProvider;
  mockProcessingDelayMs: number;
  openai: MonolithOpenAiConfig;
  pruna: MonolithPrunaConfig;
  catalog: MonolithCatalogConfig;
}

export interface LoadMonolithConfigOptions {
  requireTelegramToken?: boolean;
}

export function loadMonolithConfig(
  options: LoadMonolithConfigOptions = {},
): MonolithConfig {
  const requireTelegramToken = options.requireTelegramToken ?? true;
  const storageRoot = resolve(readString("MONOLITH_STORAGE_ROOT", ".monolith-data"));

  return {
    telegramBotToken: requireTelegramToken
      ? readRequiredString("TELEGRAM_BOT_TOKEN")
      : readOptionalString("TELEGRAM_BOT_TOKEN") ?? "",
    pollingTimeoutSeconds: readNumber("TELEGRAM_POLLING_TIMEOUT_SECONDS", 25),
    storageRoot,
    maxDownloadBytes: readNumber("MONOLITH_MAX_DOWNLOAD_BYTES", 26_214_400),
    httpTimeoutMs: readNumber(
      "MONOLITH_HTTP_TIMEOUT_MS",
      readNumber("TRYON_MODEL_HTTP_TIMEOUT_MS", 120_000),
    ),
    tryOnProvider: readTryOnProvider(),
    mockProcessingDelayMs: readNumber("MOCK_PROCESSING_DELAY_MS", 700),
    openai: {
      apiKey: readOptionalString("OPENAI_API_KEY"),
      baseUrl: readString("OPENAI_API_BASE_URL", "https://api.openai.com"),
      model: readString("MONOLITH_OPENAI_MODEL", readString("OPENAI_MODEL", "gpt-5.6-luna")),
      imageDetail: readOpenAiImageDetail(),
      textVerbosity: readOpenAiTextVerbosity(),
      reasoningEffort: readOpenAiReasoningEffort(),
      reasoningMode: readOptionalString("OPENAI_REASONING_MODE") ?? "standard",
      maxOutputTokens: readNumber(
        "MONOLITH_OPENAI_MAX_OUTPUT_TOKENS",
        readNumber("OPENAI_MAX_OUTPUT_TOKENS", 650),
      ),
      storeResponse: readBoolean("OPENAI_STORE_RESPONSE", false),
      organization: readOptionalString("OPENAI_ORGANIZATION"),
      project: readOptionalString("OPENAI_PROJECT"),
      systemPrompt: readString(
        "OPENAI_SYSTEM_PROMPT",
        "Ты аккуратный fashion assistant. Анализируй только видимые признаки стиля, одежды, цветов, пропорций и контекста гардероба. Не пытайся устанавливать личность человека и не делай выводы о чувствительных признаках.",
      ),
    },
    pruna: {
      apiKey: readOptionalString("PRUNA_API_KEY"),
      baseUrl: readString("PRUNA_API_BASE_URL", "https://api.pruna.ai"),
      model: readString("PRUNA_MODEL", "p-image-try-on"),
      predictionPathTemplate: readString(
        "PRUNA_PREDICTION_PATH_TEMPLATE",
        "/v1/predictions/{predictionId}",
      ),
      outputFormat: readString("PRUNA_OUTPUT_FORMAT", "png"),
      outputQuality: readOptionalNumber("PRUNA_OUTPUT_QUALITY"),
      preserveInputSize: readBoolean("PRUNA_PRESERVE_INPUT_SIZE", true),
      prompt: readOptionalString("PRUNA_PROMPT"),
      seed: readOptionalNumber("PRUNA_SEED"),
      turbo: readBoolean("PRUNA_TURBO", false),
    },
    catalog: {
      enabled: readBoolean("MONOLITH_CATALOG_ENABLED", true),
      refreshOnStart: readBoolean("MONOLITH_CATALOG_REFRESH_ON_START", false),
      providers: readCatalogProviders(),
      tsumSources: readTsumSources(),
      batchSize: readNonNegativeNumber("MONOLITH_CATALOG_BATCH_SIZE", 0),
      tsumMaxPages: readNonNegativeNumber("MONOLITH_CATALOG_TSUM_MAX_PAGES", 0),
      tsumPageDelayMs: readNonNegativeNumber("MONOLITH_CATALOG_TSUM_PAGE_DELAY_MS", 250),
      tsumPageRetryAttempts: readNumber("MONOLITH_CATALOG_TSUM_PAGE_RETRY_ATTEMPTS", 3),
      tsumRetryDelayMs: readNonNegativeNumber("MONOLITH_CATALOG_TSUM_RETRY_DELAY_MS", 5_000),
      tsumProgressLogEveryPages: readNumber("MONOLITH_CATALOG_TSUM_PROGRESS_EVERY_PAGES", 25),
      downloadImagesOnRefresh: readBoolean("MONOLITH_CATALOG_DOWNLOAD_IMAGES_ON_REFRESH", true),
      imageDownloadConcurrency: readNumber("MONOLITH_CATALOG_IMAGE_DOWNLOAD_CONCURRENCY", 3),
      imageDownloadDelayMs: readNonNegativeNumber("MONOLITH_CATALOG_IMAGE_DOWNLOAD_DELAY_MS", 0),
      candidatesPerCategory: readNumber("MONOLITH_CATALOG_CANDIDATES_PER_CATEGORY", 5),
      cachePath: resolve(
        readString("MONOLITH_CATALOG_CACHE_PATH", storageRoot + "/catalog/items.json"),
      ),
      browserHeadless: readBoolean("MONOLITH_CATALOG_BROWSER_HEADLESS", true),
      browserTimeoutMs: readNumber("MONOLITH_CATALOG_BROWSER_TIMEOUT_MS", 30_000),
      browserWaitUntil: readBrowserWaitUntil(),
      userAgent: readString(
        "MONOLITH_CATALOG_USER_AGENT",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ),
    },
  };
}

function readTryOnProvider(): MonolithTryOnProvider {
  const value = readString("MONOLITH_TRYON_PROVIDER", "mock").toLowerCase();

  if (value === "mock" || value === "pruna") {
    return value;
  }

  throw new Error("MONOLITH_TRYON_PROVIDER must be mock or pruna");
}

function readCatalogProviders(): MonolithCatalogProvider[] {
  const providers = readStringList("MONOLITH_CATALOG_PROVIDERS", "tsum");

  for (const provider of providers) {
    if (provider !== "tsum") {
      throw new Error("MONOLITH_CATALOG_PROVIDERS currently supports only tsum");
    }
  }

  return providers as MonolithCatalogProvider[];
}

function readTsumSources(): MonolithCatalogSource[] {
  const genericGender = readGarmentGender("MONOLITH_CATALOG_TSUM_DEFAULT_GENDER", "unisex");
  const sources: MonolithCatalogSource[] = [
    ...readStringList("MONOLITH_CATALOG_TSUM_MALE_URLS", "https://www.tsum.ru/catalog/odezhda-2409/")
      .map((url) => ({ provider: "tsum" as const, url, gender: "male" as const })),
    ...readStringList("MONOLITH_CATALOG_TSUM_FEMALE_URLS", "")
      .map((url) => ({ provider: "tsum" as const, url, gender: "female" as const })),
    ...readStringList("MONOLITH_CATALOG_TSUM_URLS", "")
      .map((url) => ({ provider: "tsum" as const, url, gender: genericGender })),
  ];
  const seen = new Set<string>();

  return sources.filter((source) => {
    const key = `${source.gender}:${source.url}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function readGarmentGender(name: string, fallback: GarmentGender): GarmentGender {
  const value = readString(name, fallback).toLowerCase();

  if (value === "male" || value === "female" || value === "unisex") {
    return value;
  }

  throw new Error(name + " must be male, female or unisex");
}

function readBrowserWaitUntil(): MonolithBrowserWaitUntil {
  const value = readString("MONOLITH_CATALOG_BROWSER_WAIT_UNTIL", "domcontentloaded").toLowerCase();

  if (value === "load" || value === "domcontentloaded" || value === "networkidle") {
    return value;
  }

  throw new Error("MONOLITH_CATALOG_BROWSER_WAIT_UNTIL must be load, domcontentloaded or networkidle");
}

function readOpenAiImageDetail(): OpenAiImageDetail {
  const value = readString("OPENAI_IMAGE_DETAIL", "high").toLowerCase();

  if (value === "low" || value === "auto" || value === "high") {
    return value;
  }

  throw new Error("OPENAI_IMAGE_DETAIL must be low, auto or high");
}

function readOpenAiTextVerbosity(): OpenAiTextVerbosity {
  const value = readString("OPENAI_TEXT_VERBOSITY", "low").toLowerCase();

  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  throw new Error("OPENAI_TEXT_VERBOSITY must be low, medium or high");
}

function readOpenAiReasoningEffort(): OpenAiReasoningEffort {
  const value = readString("OPENAI_REASONING_EFFORT", "low").toLowerCase();

  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }

  throw new Error(
    "OPENAI_REASONING_EFFORT must be none, minimal, low, medium, high, xhigh or max",
  );
}

function readRequiredString(name: string): string {
  const value = readOptionalString(name);

  if (!value || value === "replace-with-your-telegram-bot-token") {
    throw new Error(name + " is required");
  }

  return value;
}

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readOptionalString(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
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

function readOptionalNumber(name: string): number | undefined {
  const raw = process.env[name];

  if (!raw) {
    return undefined;
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
