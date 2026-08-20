import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  type PublicProtocol,
} from "../../shared/contracts/index.js";

export interface TelegramClientConfig {
  port: number;
  localUrl: string;
  clientId: string;
  publicProtocol: PublicProtocol;
  publicUrl?: string;
  coordinatorUrl: string;
  registrationKey: string;
  callbackSigningKey: string;
  callbackSigningKeyVersion: string;
  botToken: string;
  heartbeatIntervalMs: number;
  pollingTimeoutSeconds: number;
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

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readOptionalString(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function readRequiredString(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readPublicProtocol(): PublicProtocol {
  const value = readString("TELEGRAM_CLIENT_PUBLIC_PROTOCOL", "http");

  if (value !== "http" && value !== "https") {
    throw new Error("TELEGRAM_CLIENT_PUBLIC_PROTOCOL must be http or https");
  }

  return value;
}

export function loadTelegramClientConfig(): TelegramClientConfig {
  const port = readNumber("TELEGRAM_CLIENT_PORT", 4100);

  return {
    port,
    localUrl: `http://localhost:${port}`,
    clientId: readString("TELEGRAM_CLIENT_ID", "telegram-client-1"),
    publicProtocol: readPublicProtocol(),
    publicUrl: readOptionalString("TELEGRAM_CLIENT_PUBLIC_URL"),
    coordinatorUrl: readString("COORDINATOR_URL", "http://localhost:3000"),
    registrationKey: readString(
      "CLIENT_REGISTRATION_KEY",
      "dev-client-registration-key",
    ),
    callbackSigningKey: readString(
      "CLIENT_CALLBACK_SIGNING_KEY",
      "dev-client-callback-signing-key",
    ),
    callbackSigningKeyVersion: readString(
      "CLIENT_CALLBACK_SIGNING_KEY_VERSION",
      "dev-v1",
    ),
    botToken: readRequiredString("TELEGRAM_BOT_TOKEN"),
    heartbeatIntervalMs: readNumber(
      "CLIENT_HEARTBEAT_INTERVAL_MS",
      CLIENT_HEARTBEAT_INTERVAL_MS,
    ),
    pollingTimeoutSeconds: readNumber("TELEGRAM_POLLING_TIMEOUT_SECONDS", 25),
    httpClientTimeoutMs: readNumber("HTTP_CLIENT_TIMEOUT_MS", 5_000),
    httpClientRetries: readNumber("HTTP_CLIENT_RETRIES", 1),
    apiRateLimitWindowMs: readNumber("API_RATE_LIMIT_WINDOW_MS", 60_000),
    apiRateLimitMaxRequests: readNumber("API_RATE_LIMIT_MAX_REQUESTS", 120),
    maxJsonBodyBytes: readNumber("MAX_JSON_BODY_BYTES", 1_048_576),
  };
}
