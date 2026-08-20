import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  CLIENT_HEARTBEAT_TIMEOUT_MS,
  STORAGE_HEARTBEAT_INTERVAL_MS,
  STORAGE_HEARTBEAT_TIMEOUT_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TIMEOUT_MS,
} from "../../shared/contracts/index.js";

export type CoordinatorPersistenceDriver = "memory" | "postgres";

export interface CoordinatorConfig {
  port: number;
  publicUrl: string;
  workerRegistrationKey: string;
  workerServiceKey: string;
  workerDispatchSigningKey: string;
  workerDispatchSigningKeyVersion: string;
  storageRegistrationKey: string;
  storageServiceKey: string;
  storageAccessSigningKey: string;
  storageAccessSigningKeyVersion: string;
  clientCallbackSigningKey: string;
  clientCallbackSigningKeyVersion: string;
  adminApiKey: string;
  workerRegistrationMaxInvalidAttempts: number;
  storageRegistrationMaxInvalidAttempts: number;
  clientRegistrationMaxInvalidAttempts: number;
  clientRegistrationKey: string;
  requireHttpsEndpoints: boolean;
  workerHeartbeatIntervalMs: number;
  workerHeartbeatTimeoutMs: number;
  storageHeartbeatIntervalMs: number;
  storageHeartbeatTimeoutMs: number;
  clientHeartbeatIntervalMs: number;
  clientHeartbeatTimeoutMs: number;
  schedulerIntervalMs: number;
  workerDispatchTokenTtlMs: number;
  clientCallbackTokenTtlMs: number;
  storageAccessTokenTtlMs: number;
  jobAssignmentTimeoutMs: number;
  apiRateLimitWindowMs: number;
  apiRateLimitMaxRequests: number;
  httpClientTimeoutMs: number;
  httpClientRetries: number;
  maxJsonBodyBytes: number;
  persistenceDriver: CoordinatorPersistenceDriver;
  postgresUrl?: string;
  postgresSsl: boolean;
  postgresMaxConnections: number;
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

function readPersistenceDriver(): CoordinatorPersistenceDriver {
  const value = readString("COORDINATOR_PERSISTENCE", "memory");

  if (value !== "memory" && value !== "postgres") {
    throw new Error("COORDINATOR_PERSISTENCE must be memory or postgres");
  }

  return value;
}

export function loadCoordinatorConfig(): CoordinatorConfig {
  const port = readNumber("COORDINATOR_PORT", 3000);

  return {
    port,
    publicUrl: readString("COORDINATOR_PUBLIC_URL", `http://localhost:${port}`),
    workerRegistrationKey: readString(
      "WORKER_REGISTRATION_KEY",
      "dev-worker-registration-key",
    ),
    workerServiceKey: readString("WORKER_SERVICE_KEY", "dev-worker-service-key"),
    workerDispatchSigningKey: readString(
      "WORKER_DISPATCH_SIGNING_KEY",
      "dev-worker-dispatch-signing-key",
    ),
    workerDispatchSigningKeyVersion: readString(
      "WORKER_DISPATCH_SIGNING_KEY_VERSION",
      "dev-v1",
    ),
    storageRegistrationKey: readString(
      "STORAGE_REGISTRATION_KEY",
      "dev-storage-registration-key",
    ),
    storageServiceKey: readString("STORAGE_SERVICE_KEY", "dev-storage-service-key"),
    storageAccessSigningKey: readString(
      "STORAGE_ACCESS_SIGNING_KEY",
      "dev-storage-access-signing-key",
    ),
    storageAccessSigningKeyVersion: readString(
      "STORAGE_ACCESS_SIGNING_KEY_VERSION",
      "dev-v1",
    ),
    clientCallbackSigningKey: readString(
      "CLIENT_CALLBACK_SIGNING_KEY",
      "dev-client-callback-signing-key",
    ),
    clientCallbackSigningKeyVersion: readString(
      "CLIENT_CALLBACK_SIGNING_KEY_VERSION",
      "dev-v1",
    ),
    adminApiKey: readString("ADMIN_API_KEY", "dev-admin-key"),
    workerRegistrationMaxInvalidAttempts: readNumber(
      "WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS",
      5,
    ),
    storageRegistrationMaxInvalidAttempts: readNumber(
      "STORAGE_REGISTRATION_MAX_INVALID_ATTEMPTS",
      5,
    ),
    clientRegistrationMaxInvalidAttempts: readNumber(
      "CLIENT_REGISTRATION_MAX_INVALID_ATTEMPTS",
      5,
    ),
    clientRegistrationKey: readString(
      "CLIENT_REGISTRATION_KEY",
      "dev-client-registration-key",
    ),
    requireHttpsEndpoints: readBoolean("REQUIRE_HTTPS_ENDPOINTS", false),
    workerHeartbeatIntervalMs: readNumber(
      "WORKER_HEARTBEAT_INTERVAL_MS",
      WORKER_HEARTBEAT_INTERVAL_MS,
    ),
    workerHeartbeatTimeoutMs: readNumber(
      "WORKER_HEARTBEAT_TIMEOUT_MS",
      WORKER_HEARTBEAT_TIMEOUT_MS,
    ),
    storageHeartbeatIntervalMs: readNumber(
      "STORAGE_HEARTBEAT_INTERVAL_MS",
      STORAGE_HEARTBEAT_INTERVAL_MS,
    ),
    storageHeartbeatTimeoutMs: readNumber(
      "STORAGE_HEARTBEAT_TIMEOUT_MS",
      STORAGE_HEARTBEAT_TIMEOUT_MS,
    ),
    clientHeartbeatIntervalMs: readNumber(
      "CLIENT_HEARTBEAT_INTERVAL_MS",
      CLIENT_HEARTBEAT_INTERVAL_MS,
    ),
    clientHeartbeatTimeoutMs: readNumber(
      "CLIENT_HEARTBEAT_TIMEOUT_MS",
      CLIENT_HEARTBEAT_TIMEOUT_MS,
    ),
    schedulerIntervalMs: readNumber("SCHEDULER_INTERVAL_MS", 1_000),
    workerDispatchTokenTtlMs: readNumber("WORKER_DISPATCH_TOKEN_TTL_MS", 30_000),
    clientCallbackTokenTtlMs: readNumber("CLIENT_CALLBACK_TOKEN_TTL_MS", 900_000),
    storageAccessTokenTtlMs: readNumber("STORAGE_ACCESS_TOKEN_TTL_MS", 900_000),
    jobAssignmentTimeoutMs: readNumber("JOB_ASSIGNMENT_TIMEOUT_MS", 30_000),
    apiRateLimitWindowMs: readNumber("API_RATE_LIMIT_WINDOW_MS", 60_000),
    apiRateLimitMaxRequests: readNumber("API_RATE_LIMIT_MAX_REQUESTS", 120),
    httpClientTimeoutMs: readNumber("HTTP_CLIENT_TIMEOUT_MS", 5_000),
    httpClientRetries: readNumber("HTTP_CLIENT_RETRIES", 1),
    maxJsonBodyBytes: readNumber("MAX_JSON_BODY_BYTES", 1_048_576),
    persistenceDriver: readPersistenceDriver(),
    postgresUrl: readOptionalString("POSTGRES_URL"),
    postgresSsl: readBoolean("POSTGRES_SSL", false),
    postgresMaxConnections: readNumber("POSTGRES_MAX_CONNECTIONS", 10),
  };
}
