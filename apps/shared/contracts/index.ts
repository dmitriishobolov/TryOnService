export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_TIMEOUT_MS = 15_000;

export type ClientType = "telegram";

export type JobStatus =
  | "queued"
  | "assigned"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkerStatus = "ready" | "busy" | "offline";

export interface TelegramClientRef {
  type: "telegram";
  chatId: string;
  username?: string;
}

export type ClientRef = TelegramClientRef;

export interface CreateTryOnJobRequest {
  client: ClientRef;
  payload: {
    command: "request";
    text?: string;
  };
  callbackUrl?: string;
}

export interface TryOnJobResult {
  message: string;
}

export interface TryOnJobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TryOnJob {
  id: string;
  status: JobStatus;
  client: ClientRef;
  payload: CreateTryOnJobRequest["payload"];
  callbackUrl?: string;
  assignedWorkerId?: string;
  result?: TryOnJobResult;
  error?: TryOnJobError;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerCapability {
  name: string;
}

export interface WorkerRegistrationRequest {
  workerId: string;
  baseUrl: string;
  capacity: number;
  capabilities: WorkerCapability[];
}

export interface WorkerRegistrationResponse {
  workerId: string;
  heartbeatIntervalMs: number;
}

export interface WorkerHeartbeatRequest {
  workerId: string;
  status: WorkerStatus;
  runningJobs: number;
  capacity: number;
}

export interface RegisteredWorker {
  workerId: string;
  baseUrl: string;
  status: WorkerStatus;
  capacity: number;
  runningJobs: number;
  capabilities: WorkerCapability[];
  registeredAt: string;
  lastHeartbeatAt: string;
}

export interface WorkerJobRequest {
  jobId: string;
  client: ClientRef;
  payload: CreateTryOnJobRequest["payload"];
  callbackUrl?: string;
  coordinator: {
    progressUrl: string;
    resultUrl: string;
  };
}

export interface WorkerJobAcceptedResponse {
  jobId: string;
  accepted: boolean;
}

export interface JobProgressUpdateRequest {
  jobId: string;
  status: Extract<JobStatus, "running">;
  message?: string;
}

export interface JobResultUpdateRequest {
  jobId: string;
  status: Extract<JobStatus, "succeeded" | "failed">;
  result?: TryOnJobResult;
  error?: TryOnJobError;
}

export interface TelegramJobCallbackRequest {
  jobId: string;
  client: TelegramClientRef;
  result: TryOnJobResult;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCreateTryOnJobRequest(
  value: unknown,
): value is CreateTryOnJobRequest {
  if (!isObject(value) || !isObject(value.client) || !isObject(value.payload)) {
    return false;
  }

  const { client, payload } = value;

  return (
    client.type === "telegram" &&
    typeof client.chatId === "string" &&
    client.chatId.length > 0 &&
    payload.command === "request" &&
    (value.callbackUrl === undefined || typeof value.callbackUrl === "string")
  );
}

export function isWorkerRegistrationRequest(
  value: unknown,
): value is WorkerRegistrationRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.workerId === "string" &&
    value.workerId.length > 0 &&
    typeof value.baseUrl === "string" &&
    value.baseUrl.length > 0 &&
    typeof value.capacity === "number" &&
    value.capacity > 0 &&
    Array.isArray(value.capabilities)
  );
}

export function isWorkerHeartbeatRequest(
  value: unknown,
): value is WorkerHeartbeatRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.workerId === "string" &&
    (value.status === "ready" ||
      value.status === "busy" ||
      value.status === "offline") &&
    typeof value.runningJobs === "number" &&
    typeof value.capacity === "number"
  );
}

export function isWorkerJobRequest(value: unknown): value is WorkerJobRequest {
  if (!isObject(value) || !isObject(value.client) || !isObject(value.payload)) {
    return false;
  }

  return (
    typeof value.jobId === "string" &&
    value.client.type === "telegram" &&
    typeof value.client.chatId === "string" &&
    value.payload.command === "request"
  );
}

export function isJobProgressUpdateRequest(
  value: unknown,
): value is JobProgressUpdateRequest {
  return (
    isObject(value) &&
    typeof value.jobId === "string" &&
    value.status === "running"
  );
}

export function isJobResultUpdateRequest(
  value: unknown,
): value is JobResultUpdateRequest {
  if (!isObject(value) || typeof value.jobId !== "string") {
    return false;
  }

  if (value.status === "succeeded") {
    return isObject(value.result) && typeof value.result.message === "string";
  }

  if (value.status === "failed") {
    return isObject(value.error) && typeof value.error.message === "string";
  }

  return false;
}

export function isTelegramJobCallbackRequest(
  value: unknown,
): value is TelegramJobCallbackRequest {
  return (
    isObject(value) &&
    typeof value.jobId === "string" &&
    isObject(value.client) &&
    value.client.type === "telegram" &&
    typeof value.client.chatId === "string" &&
    isObject(value.result) &&
    typeof value.result.message === "string"
  );
}
