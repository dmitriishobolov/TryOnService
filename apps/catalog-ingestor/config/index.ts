import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  type PublicProtocol,
} from "../../shared/contracts/index.js";
import type { CatalogProviderName } from "../catalog/types.js";
import { catalogProviderNames } from "../catalog/types.js";

export interface CatalogIngestorConfig {
  port: number;
  localUrl: string;
  clientId: string;
  publicProtocol: PublicProtocol;
  publicUrl?: string;
  coordinatorUrl: string;
  registrationKey: string;
  heartbeatIntervalMs: number;
  enabled: boolean;
  runOnStart: boolean;
  syncIntervalMs: number;
  batchSize: number;
  providers: CatalogProviderName[];
  storagePrefix: string;
  userAgent: string;
  customSourceFile?: string;
  imageDownloadTimeoutMs: number;
  maxImageBytes: number;
  httpClientTimeoutMs: number;
  httpClientRetries: number;
  apiRateLimitWindowMs: number;
  apiRateLimitMaxRequests: number;
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

function readInteger(name: string, fallback: number): number {
  const value = readNumber(name, fallback);

  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
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
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }

  if (value === "false" || value === "0" || value === "no") {
    return false;
  }

  throw new Error(`${name} must be a boolean`);
}

function readPublicProtocol(): PublicProtocol {
  const value = readString("CATALOG_INGESTOR_PUBLIC_PROTOCOL", "http");

  if (value !== "http" && value !== "https") {
    throw new Error("CATALOG_INGESTOR_PUBLIC_PROTOCOL must be http or https");
  }

  return value;
}

function readProviders(): CatalogProviderName[] {
  const raw = readString(
    "CATALOG_INGESTOR_PROVIDERS",
    catalogProviderNames.join(","),
  );
  const known = new Set<string>(catalogProviderNames);
  const providers = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  for (const provider of providers) {
    if (!known.has(provider)) {
      throw new Error(
        `Unknown catalog provider ${provider}. Known providers: ${catalogProviderNames.join(", ")}`,
      );
    }
  }

  return [...new Set(providers)] as CatalogProviderName[];
}

function sanitizeStorageRequesterId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function loadCatalogIngestorConfig(): CatalogIngestorConfig {
  const port = readInteger("CATALOG_INGESTOR_PORT", 4300);
  const clientId = readString("CATALOG_INGESTOR_CLIENT_ID", "catalog-ingestor-1");
  const storagePrefix = readOptionalString("CATALOG_INGESTOR_STORAGE_PREFIX") ??
    `clients/${sanitizeStorageRequesterId(clientId)}/catalog`;

  return {
    port,
    localUrl: `http://localhost:${port}`,
    clientId,
    publicProtocol: readPublicProtocol(),
    publicUrl: readOptionalString("CATALOG_INGESTOR_PUBLIC_URL"),
    coordinatorUrl: readString("COORDINATOR_URL", "http://localhost:3000"),
    registrationKey: readString(
      "CLIENT_REGISTRATION_KEY",
      "dev-client-registration-key",
    ),
    heartbeatIntervalMs: readNumber(
      "CLIENT_HEARTBEAT_INTERVAL_MS",
      CLIENT_HEARTBEAT_INTERVAL_MS,
    ),
    enabled: readBoolean("CATALOG_INGESTOR_ENABLED", false),
    runOnStart: readBoolean("CATALOG_INGESTOR_RUN_ON_START", true),
    syncIntervalMs: readNumber("CATALOG_INGESTOR_SYNC_INTERVAL_MS", 3_600_000),
    batchSize: readInteger("CATALOG_INGESTOR_BATCH_SIZE", 50),
    providers: readProviders(),
    storagePrefix,
    userAgent: readString(
      "CATALOG_INGESTOR_USER_AGENT",
      "TryOnServiceCatalogIngestor/0.1",
    ),
    customSourceFile: readOptionalString("CATALOG_INGESTOR_CUSTOM_SOURCE_FILE"),
    imageDownloadTimeoutMs: readNumber(
      "CATALOG_INGESTOR_IMAGE_DOWNLOAD_TIMEOUT_MS",
      120_000,
    ),
    maxImageBytes: readNumber("CATALOG_INGESTOR_MAX_IMAGE_BYTES", 26_214_400),
    httpClientTimeoutMs: readNumber("HTTP_CLIENT_TIMEOUT_MS", 5_000),
    httpClientRetries: readNumber("HTTP_CLIENT_RETRIES", 1),
    apiRateLimitWindowMs: readNumber("API_RATE_LIMIT_WINDOW_MS", 60_000),
    apiRateLimitMaxRequests: readNumber("API_RATE_LIMIT_MAX_REQUESTS", 120),
    maxJsonBodyBytes: readNumber("MAX_JSON_BODY_BYTES", 1_048_576),
  };
}
