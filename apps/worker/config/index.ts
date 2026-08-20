import { hostname } from "node:os";

import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  type PublicProtocol,
  type WorkerCapability,
} from "../../shared/contracts/index.js";

export interface WorkerConfig {
  port: number;
  workerId: string;
  localUrl: string;
  publicProtocol: PublicProtocol;
  publicUrl?: string;
  coordinatorUrl: string;
  registrationKey: string;
  capacity: number;
  capabilities: WorkerCapability[];
  heartbeatIntervalMs: number;
  mockProcessingDelayMs: number;
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

function readPublicProtocol(): PublicProtocol {
  const value = readString("WORKER_PUBLIC_PROTOCOL", "http");

  if (value !== "http" && value !== "https") {
    throw new Error("WORKER_PUBLIC_PROTOCOL must be http or https");
  }

  return value;
}

function readCapabilities(): WorkerCapability[] {
  const raw = readString("WORKER_CAPABILITIES", "try-on.mock");

  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

export function loadWorkerConfig(): WorkerConfig {
  const port = readNumber("WORKER_PORT", 4001);
  const workerId = readString("WORKER_ID", `${hostname()}-${port}`);

  return {
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
    capacity: readNumber("WORKER_CAPACITY", 1),
    capabilities: readCapabilities(),
    heartbeatIntervalMs: readNumber(
      "WORKER_HEARTBEAT_INTERVAL_MS",
      WORKER_HEARTBEAT_INTERVAL_MS,
    ),
    mockProcessingDelayMs: readNumber("MOCK_PROCESSING_DELAY_MS", 700),
  };
}
