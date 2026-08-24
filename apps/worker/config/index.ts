import { hostname } from "node:os";

import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  type PublicProtocol,
  type TryOnModelProvider,
  type WorkerCapability,
} from "../../shared/contracts/index.js";

export type TryOnCloudMode = "developer" | "platform";
export type GenlookUploadMode = "multipart" | "url";
export type WearfitsImageInputMode = "base64" | "url";
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

export interface PrunaTryOnConfig {
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

export interface PixelcutTryOnConfig {
  apiKey?: string;
  baseUrl: string;
  jobStatusPathTemplate: string;
  garmentMode: string;
  preprocessGarment: boolean;
  removeBackground: boolean;
}

export interface TryOnCloudConfig {
  apiKey?: string;
  baseUrl: string;
  mode: TryOnCloudMode;
}

export interface GenlookTryOnConfig {
  apiKey?: string;
  baseUrl: string;
  apiKeyHeader: string;
  apiKeyPrefix?: string;
  uploadMode: GenlookUploadMode;
  uploadPath: string;
  tryOnPath: string;
  generationPathTemplate: string;
}

export interface WearfitsTryOnConfig {
  apiKey?: string;
  baseUrl: string;
  imageInputMode: WearfitsImageInputMode;
  productCategory: string;
  quality: string;
  preserveBackground: boolean;
}

export interface OpenAiTryOnConfig {
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
  appearancePrompt: string;
}

export interface WorkerConfig {
  port: number;
  workerId: string;
  localUrl: string;
  publicProtocol: PublicProtocol;
  publicUrl?: string;
  coordinatorUrl: string;
  registrationKey: string;
  serviceKey: string;
  dispatchSigningKey: string;
  dispatchSigningKeyVersion: string;
  capacity: number;
  capabilities: WorkerCapability[];
  heartbeatIntervalMs: number;
  tryOnPersonImageIndex: number;
  tryOnGarmentImageIndex: number;
  tryOnModelPollIntervalMs: number;
  tryOnModelMaxPollAttempts: number;
  tryOnModelHttpTimeoutMs: number;
  mockProcessingDelayMs: number;
  pruna: PrunaTryOnConfig;
  pixelcut: PixelcutTryOnConfig;
  tryOnCloud: TryOnCloudConfig;
  genlook: GenlookTryOnConfig;
  wearfits: WearfitsTryOnConfig;
  openai: OpenAiTryOnConfig;
  apiRateLimitWindowMs: number;
  apiRateLimitMaxRequests: number;
  httpClientTimeoutMs: number;
  httpClientRetries: number;
  maxJsonBodyBytes: number;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
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
    throw new Error(`${name} must be a non-negative number`);
  }

  return value;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readOptionalString(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
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

  throw new Error(`${name} must be a boolean`);
}

function readPublicProtocol(): PublicProtocol {
  const value = readString("WORKER_PUBLIC_PROTOCOL", "http");

  if (value !== "http" && value !== "https") {
    throw new Error("WORKER_PUBLIC_PROTOCOL must be http or https");
  }

  return value;
}

function readTryOnCloudMode(): TryOnCloudMode {
  const value = readString("TRYONCLOUD_MODE", "developer").toLowerCase();

  if (value !== "developer" && value !== "platform") {
    throw new Error("TRYONCLOUD_MODE must be developer or platform");
  }

  return value;
}

function readGenlookUploadMode(): GenlookUploadMode {
  const value = readString("GENLOOK_UPLOAD_MODE", "multipart").toLowerCase();

  if (value !== "multipart" && value !== "url") {
    throw new Error("GENLOOK_UPLOAD_MODE must be multipart or url");
  }

  return value;
}

function readWearfitsImageInputMode(): WearfitsImageInputMode {
  const value = readString("WEARFITS_IMAGE_INPUT_MODE", "base64").toLowerCase();

  if (value !== "base64" && value !== "url") {
    throw new Error("WEARFITS_IMAGE_INPUT_MODE must be base64 or url");
  }

  return value;
}

function readOpenAiImageDetail(): OpenAiImageDetail {
  const value = readString("OPENAI_IMAGE_DETAIL", "high").toLowerCase();

  if (value !== "low" && value !== "auto" && value !== "high") {
    throw new Error("OPENAI_IMAGE_DETAIL must be low, auto or high");
  }

  return value;
}

function readOpenAiTextVerbosity(): OpenAiTextVerbosity {
  const value = readString("OPENAI_TEXT_VERBOSITY", "medium").toLowerCase();

  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new Error("OPENAI_TEXT_VERBOSITY must be low, medium or high");
  }

  return value;
}

function readOpenAiReasoningEffort(): OpenAiReasoningEffort {
  const value = readString("OPENAI_REASONING_EFFORT", "low").toLowerCase();

  if (
    value !== "none" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new Error(
      "OPENAI_REASONING_EFFORT must be none, minimal, low, medium, high, xhigh or max",
    );
  }

  return value;
}

function readCapabilities(): WorkerCapability[] {
  const raw = readOptionalString("WORKER_CAPABILITIES");
  const names = new Set(
    (raw ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );

  names.add("try-on");
  names.add("try-on.mock");
  syncProviderCapability(names, "pruna", "PRUNA_API_KEY");
  syncProviderCapability(names, "pixelcut", "PIXELCUT_API_KEY");
  syncProviderCapability(names, "tryoncloud", "TRYONCLOUD_API_KEY");
  syncProviderCapability(names, "genlook", "GENLOOK_API_KEY");
  syncProviderCapability(names, "wearfits", "WEARFITS_API_KEY");
  syncProviderCapability(names, "openai", "OPENAI_API_KEY");

  return [...names].map((name) => ({ name }));
}

function syncProviderCapability(
  names: Set<string>,
  provider: TryOnModelProvider,
  apiKeyName: string,
): void {
  const capability = `try-on.${provider}`;

  if (readOptionalString(apiKeyName)) {
    names.add(capability);
    return;
  }

  names.delete(capability);
}

export function loadWorkerConfig(): WorkerConfig {
  const port = readNumber("WORKER_PORT", 4001);
  const workerId = readString("WORKER_ID", `${hostname()}-${port}`);

  const config: WorkerConfig = {
    port,
    workerId,
    localUrl: `http://localhost:${port}`,
    publicProtocol: readPublicProtocol(),
    publicUrl: readOptionalString("WORKER_PUBLIC_URL"),
    coordinatorUrl: readString("COORDINATOR_URL", "http://localhost:3000"),
    registrationKey: readString(
      "WORKER_REGISTRATION_KEY",
      "dev-worker-registration-key",
    ),
    serviceKey: readString("WORKER_SERVICE_KEY", "dev-worker-service-key"),
    dispatchSigningKey: readString(
      "WORKER_DISPATCH_SIGNING_KEY",
      "dev-worker-dispatch-signing-key",
    ),
    dispatchSigningKeyVersion: readString(
      "WORKER_DISPATCH_SIGNING_KEY_VERSION",
      "dev-v1",
    ),
    capacity: readNumber("WORKER_CAPACITY", 1),
    capabilities: readCapabilities(),
    heartbeatIntervalMs: readNumber(
      "WORKER_HEARTBEAT_INTERVAL_MS",
      WORKER_HEARTBEAT_INTERVAL_MS,
    ),
    tryOnPersonImageIndex: readNonNegativeInteger("TRYON_PERSON_IMAGE_INDEX", 0),
    tryOnGarmentImageIndex: readNonNegativeInteger("TRYON_GARMENT_IMAGE_INDEX", 1),
    tryOnModelPollIntervalMs: readNumber("TRYON_MODEL_POLL_INTERVAL_MS", 2_000),
    tryOnModelMaxPollAttempts: readNumber("TRYON_MODEL_MAX_POLL_ATTEMPTS", 60),
    tryOnModelHttpTimeoutMs: readNumber("TRYON_MODEL_HTTP_TIMEOUT_MS", 120_000),
    mockProcessingDelayMs: readNumber("MOCK_PROCESSING_DELAY_MS", 700),
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
    pixelcut: {
      apiKey: readOptionalString("PIXELCUT_API_KEY"),
      baseUrl: readString(
        "PIXELCUT_API_BASE_URL",
        "https://api.developer.pixelcut.ai",
      ),
      jobStatusPathTemplate: readString(
        "PIXELCUT_JOB_STATUS_PATH_TEMPLATE",
        "/v1/try-on/{jobId}",
      ),
      garmentMode: readString("PIXELCUT_GARMENT_MODE", "auto"),
      preprocessGarment: readBoolean("PIXELCUT_PREPROCESS_GARMENT", true),
      removeBackground: readBoolean("PIXELCUT_REMOVE_BACKGROUND", false),
    },
    tryOnCloud: {
      apiKey: readOptionalString("TRYONCLOUD_API_KEY"),
      baseUrl: readString("TRYONCLOUD_API_BASE_URL", "https://www.tryoncloud.com"),
      mode: readTryOnCloudMode(),
    },
    genlook: {
      apiKey: readOptionalString("GENLOOK_API_KEY"),
      baseUrl: readString("GENLOOK_API_BASE_URL", "https://api.genlook.app"),
      apiKeyHeader: readString("GENLOOK_API_KEY_HEADER", "Authorization"),
      apiKeyPrefix: readOptionalString("GENLOOK_API_KEY_PREFIX") ?? "Bearer",
      uploadMode: readGenlookUploadMode(),
      uploadPath: readString("GENLOOK_UPLOAD_PATH", "/tryon/v1/images/upload"),
      tryOnPath: readString("GENLOOK_TRYON_PATH", "/tryon/v1/try-on"),
      generationPathTemplate: readString(
        "GENLOOK_GENERATION_PATH_TEMPLATE",
        "/tryon/v1/generations/{generationId}",
      ),
    },
    wearfits: {
      apiKey: readOptionalString("WEARFITS_API_KEY"),
      baseUrl: readString("WEARFITS_API_BASE_URL", "https://api.wearfits.com"),
      imageInputMode: readWearfitsImageInputMode(),
      productCategory: readString("WEARFITS_PRODUCT_CATEGORY", "auto"),
      quality: readString("WEARFITS_QUALITY", "standard"),
      preserveBackground: readBoolean("WEARFITS_PRESERVE_BACKGROUND", true),
    },
    openai: {
      apiKey: readOptionalString("OPENAI_API_KEY"),
      baseUrl: readString("OPENAI_API_BASE_URL", "https://api.openai.com"),
      model: readString("OPENAI_MODEL", "gpt-5.6-luna"),
      imageDetail: readOpenAiImageDetail(),
      textVerbosity: readOpenAiTextVerbosity(),
      reasoningEffort: readOpenAiReasoningEffort(),
      reasoningMode: readOptionalString("OPENAI_REASONING_MODE") ?? "standard",
      maxOutputTokens: readNumber("OPENAI_MAX_OUTPUT_TOKENS", 900),
      storeResponse: readBoolean("OPENAI_STORE_RESPONSE", false),
      organization: readOptionalString("OPENAI_ORGANIZATION"),
      project: readOptionalString("OPENAI_PROJECT"),
      systemPrompt: readString(
        "OPENAI_SYSTEM_PROMPT",
        "Ты аккуратный fashion assistant. Анализируй только видимые признаки стиля, одежды, цветов, пропорций и контекста гардероба. Не пытайся устанавливать личность человека и не делай выводы о чувствительных признаках.",
      ),
      appearancePrompt: readString(
        "OPENAI_APPEARANCE_PROMPT",
        "Кратко проанализируй внешность человека на фотографии. Сначала дай 2-3 живые фразы общего вывода: что считывается во внешности, что стоит подчеркнуть и какая подача будет смотреться естественно. Затем дай блок параметров: форма лица, визуальный контраст, видимые пропорции, подходящие цвета, чего избегать, фасоны одежды, аксессуары, прическа и 3 стилевых направления. Не более 1300 символов. Не используй длинное тире, символ U+2014 и похожие длинные тире; вместо них ставь запятую, двоеточие, точку с запятой или обычный дефис. Не пытайся устанавливать личность человека. Если освещение мешает точно определить цветотип, явно скажи об этом.",
      ),
    },
    apiRateLimitWindowMs: readNumber("API_RATE_LIMIT_WINDOW_MS", 60_000),
    apiRateLimitMaxRequests: readNumber("API_RATE_LIMIT_MAX_REQUESTS", 120),
    httpClientTimeoutMs: readNumber("HTTP_CLIENT_TIMEOUT_MS", 5_000),
    httpClientRetries: readNumber("HTTP_CLIENT_RETRIES", 1),
    maxJsonBodyBytes: readNumber("MAX_JSON_BODY_BYTES", 1_048_576),
  };

  return config;
}
