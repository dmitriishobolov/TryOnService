import { hostname } from "node:os";

import {
  STORAGE_HEARTBEAT_INTERVAL_MS,
  type PublicProtocol,
  type StorageObjectDriver,
} from "../../shared/contracts/index.js";

export interface StorageConfig {
  port: number;
  storageId: string;
  localUrl: string;
  publicProtocol: PublicProtocol;
  publicUrl?: string;
  coordinatorUrl: string;
  registrationKey: string;
  serviceKey: string;
  accessSigningKey: string;
  accessSigningKeyVersion: string;
  driver: StorageObjectDriver;
  localRoot: string;
  metadataPath?: string;
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle: boolean;
  capacityBytes?: number;
  heartbeatIntervalMs: number;
  apiRateLimitWindowMs: number;
  apiRateLimitMaxRequests: number;
  httpClientTimeoutMs: number;
  httpClientRetries: number;
  maxJsonBodyBytes: number;
  maxObjectBytes: number;
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

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
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
  const value = readString("STORAGE_PUBLIC_PROTOCOL", "http");

  if (value !== "http" && value !== "https") {
    throw new Error("STORAGE_PUBLIC_PROTOCOL must be http or https");
  }

  return value;
}

function readDriver(): StorageObjectDriver {
  const value = readString("STORAGE_DRIVER", "local");

  if (value !== "local" && value !== "s3") {
    throw new Error("STORAGE_DRIVER must be local or s3");
  }

  return value;
}

export function loadStorageConfig(): StorageConfig {
  const port = readNumber("STORAGE_PORT", 4200);
  const storageId = readString("STORAGE_ID", `${hostname()}-${port}`);
  const driver = readDriver();
  const s3Endpoint = readOptionalString("STORAGE_S3_ENDPOINT");
  const s3Bucket = readOptionalString("STORAGE_S3_BUCKET");
  const s3AccessKeyId = readOptionalString("STORAGE_S3_ACCESS_KEY_ID");
  const s3SecretAccessKey = readOptionalString("STORAGE_S3_SECRET_ACCESS_KEY");

  if (
    driver === "s3" &&
    (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)
  ) {
    throw new Error(
      "STORAGE_DRIVER=s3 requires STORAGE_S3_ENDPOINT, STORAGE_S3_BUCKET, STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY",
    );
  }

  return {
    port,
    storageId,
    localUrl: `http://localhost:${port}`,
    publicProtocol: readPublicProtocol(),
    publicUrl: readOptionalString("STORAGE_PUBLIC_URL"),
    coordinatorUrl: readString("COORDINATOR_URL", "http://localhost:3000"),
    registrationKey: readString(
      "STORAGE_REGISTRATION_KEY",
      "dev-storage-registration-key",
    ),
    serviceKey: readString("STORAGE_SERVICE_KEY", "dev-storage-service-key"),
    accessSigningKey: readString(
      "STORAGE_ACCESS_SIGNING_KEY",
      "dev-storage-access-signing-key",
    ),
    accessSigningKeyVersion: readString(
      "STORAGE_ACCESS_SIGNING_KEY_VERSION",
      "dev-v1",
    ),
    driver,
    localRoot: readString("STORAGE_LOCAL_ROOT", "tmp/storage"),
    metadataPath: readOptionalString("STORAGE_METADATA_PATH"),
    s3Endpoint,
    s3Region: readString("STORAGE_S3_REGION", "us-east-1"),
    s3Bucket,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3ForcePathStyle: readBoolean("STORAGE_S3_FORCE_PATH_STYLE", true),
    capacityBytes: readOptionalNumber("STORAGE_CAPACITY_BYTES"),
    heartbeatIntervalMs: readNumber(
      "STORAGE_HEARTBEAT_INTERVAL_MS",
      STORAGE_HEARTBEAT_INTERVAL_MS,
    ),
    apiRateLimitWindowMs: readNumber("API_RATE_LIMIT_WINDOW_MS", 60_000),
    apiRateLimitMaxRequests: readNumber("API_RATE_LIMIT_MAX_REQUESTS", 120),
    httpClientTimeoutMs: readNumber("HTTP_CLIENT_TIMEOUT_MS", 5_000),
    httpClientRetries: readNumber("HTTP_CLIENT_RETRIES", 1),
    maxJsonBodyBytes: readNumber("MAX_JSON_BODY_BYTES", 1_048_576),
    maxObjectBytes: readNumber("STORAGE_MAX_OBJECT_BYTES", 25 * 1024 * 1024),
  };
}
