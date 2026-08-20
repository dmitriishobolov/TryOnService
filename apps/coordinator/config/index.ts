import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  CLIENT_HEARTBEAT_TIMEOUT_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TIMEOUT_MS,
} from "../../shared/contracts/index.js";

export type CoordinatorPersistenceDriver = "memory" | "postgres";
export type CoordinatorStorageDriver = "local" | "s3";

export interface CoordinatorConfig {
  port: number;
  publicUrl: string;
  workerRegistrationKey: string;
  workerServiceKey: string;
  workerDispatchSigningKey: string;
  clientCallbackSigningKey: string;
  adminApiKey: string;
  workerRegistrationMaxInvalidAttempts: number;
  clientRegistrationKey: string;
  workerHeartbeatIntervalMs: number;
  workerHeartbeatTimeoutMs: number;
  clientHeartbeatIntervalMs: number;
  clientHeartbeatTimeoutMs: number;
  schedulerIntervalMs: number;
  workerDispatchTokenTtlMs: number;
  clientCallbackTokenTtlMs: number;
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
  storageDriver: CoordinatorStorageDriver;
  storageLocalRoot: string;
  storagePublicBaseUrl?: string;
  storageBucket?: string;
  storageSignedUrlTtlMs: number;
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

function readStorageDriver(): CoordinatorStorageDriver {
  const value = readString("STORAGE_DRIVER", "local");

  if (value !== "local" && value !== "s3") {
    throw new Error("STORAGE_DRIVER must be local or s3");
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
    clientCallbackSigningKey: readString(
      "CLIENT_CALLBACK_SIGNING_KEY",
      "dev-client-callback-signing-key",
    ),
    adminApiKey: readString("ADMIN_API_KEY", "dev-admin-key"),
    workerRegistrationMaxInvalidAttempts: readNumber(
      "WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS",
      5,
    ),
    clientRegistrationKey: readString(
      "CLIENT_REGISTRATION_KEY",
      "dev-client-registration-key",
    ),
    workerHeartbeatIntervalMs: readNumber(
      "WORKER_HEARTBEAT_INTERVAL_MS",
      WORKER_HEARTBEAT_INTERVAL_MS,
    ),
    workerHeartbeatTimeoutMs: readNumber(
      "WORKER_HEARTBEAT_TIMEOUT_MS",
      WORKER_HEARTBEAT_TIMEOUT_MS,
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
    storageDriver: readStorageDriver(),
    storageLocalRoot: readString("STORAGE_LOCAL_ROOT", "tmp/storage"),
    storagePublicBaseUrl: readOptionalString("STORAGE_PUBLIC_BASE_URL"),
    storageBucket: readOptionalString("STORAGE_BUCKET"),
    storageSignedUrlTtlMs: readNumber("STORAGE_SIGNED_URL_TTL_MS", 900_000),
  };
}
