import { hostname } from "node:os";

import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  type PublicProtocol,
  type WorkerCapability,
} from "../../shared/contracts/index.js";

export type TryOnModelProvider =
  | "mock"
  | "pruna"
  | "pixelcut"
  | "tryoncloud"
  | "genlook"
  | "wearfits";

export type TryOnCloudMode = "developer" | "platform";
export type GenlookUploadMode = "multipart" | "url";
export type WearfitsImageInputMode = "base64" | "url";

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
  tryOnModelProvider: TryOnModelProvider;
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

function readTryOnModelProvider(): TryOnModelProvider {
  const value = readString("TRYON_MODEL_PROVIDER", "mock").toLowerCase();

  if (
    value !== "mock" &&
    value !== "pruna" &&
    value !== "pixelcut" &&
    value !== "tryoncloud" &&
    value !== "genlook" &&
    value !== "wearfits"
  ) {
    throw new Error(
      "TRYON_MODEL_PROVIDER must be mock, pruna, pixelcut, tryoncloud, genlook or wearfits",
    );
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

function readCapabilities(provider: TryOnModelProvider): WorkerCapability[] {
  const raw = readOptionalString("WORKER_CAPABILITIES");
  const names = new Set(
    (raw ?? "try-on,try-on.mock")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );

  names.add("try-on");
  names.add(`try-on.${provider}`);

  return [...names].map((name) => ({ name }));
}

export function loadWorkerConfig(): WorkerConfig {
  const port = readNumber("WORKER_PORT", 4001);
  const workerId = readString("WORKER_ID", `${hostname()}-${port}`);
  const tryOnModelProvider = readTryOnModelProvider();

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
    capabilities: readCapabilities(tryOnModelProvider),
    heartbeatIntervalMs: readNumber(
      "WORKER_HEARTBEAT_INTERVAL_MS",
      WORKER_HEARTBEAT_INTERVAL_MS,
    ),
    tryOnModelProvider,
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
    apiRateLimitWindowMs: readNumber("API_RATE_LIMIT_WINDOW_MS", 60_000),
    apiRateLimitMaxRequests: readNumber("API_RATE_LIMIT_MAX_REQUESTS", 120),
    httpClientTimeoutMs: readNumber("HTTP_CLIENT_TIMEOUT_MS", 5_000),
    httpClientRetries: readNumber("HTTP_CLIENT_RETRIES", 1),
    maxJsonBodyBytes: readNumber("MAX_JSON_BODY_BYTES", 1_048_576),
  };

  validateSelectedProviderConfig(config);

  return config;
}

function validateSelectedProviderConfig(config: WorkerConfig): void {
  const requiredApiKeys: Record<TryOnModelProvider, string | undefined> = {
    mock: "ok",
    pruna: config.pruna.apiKey,
    pixelcut: config.pixelcut.apiKey,
    tryoncloud: config.tryOnCloud.apiKey,
    genlook: config.genlook.apiKey,
    wearfits: config.wearfits.apiKey,
  };

  if (!requiredApiKeys[config.tryOnModelProvider]) {
    throw new Error(
      `${config.tryOnModelProvider} provider requires ${apiKeyEnvName(config.tryOnModelProvider)}`,
    );
  }
}

function apiKeyEnvName(provider: TryOnModelProvider): string {
  const names: Record<TryOnModelProvider, string> = {
    mock: "no api key",
    pruna: "PRUNA_API_KEY",
    pixelcut: "PIXELCUT_API_KEY",
    tryoncloud: "TRYONCLOUD_API_KEY",
    genlook: "GENLOOK_API_KEY",
    wearfits: "WEARFITS_API_KEY",
  };

  return names[provider];
}
