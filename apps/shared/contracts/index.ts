export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_TIMEOUT_MS = 15_000;
export const CLIENT_HEARTBEAT_INTERVAL_MS = 5_000;
export const CLIENT_HEARTBEAT_TIMEOUT_MS = 15_000;

export type ClientType = "telegram";
export type ClientStatus = "ready" | "offline";

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
  sourceClientId: string;
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
  sourceClientId: string;
  client: ClientRef;
  payload: CreateTryOnJobRequest["payload"];
  callbackUrl?: string;
  assignedWorkerId?: string;
  assignedAt?: string;
  dispatchTokenExpiresAt?: string;
  result?: TryOnJobResult;
  error?: TryOnJobError;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerCapability {
  name: string;
}

export type PublicProtocol = "http" | "https";

export interface WorkerRegistrationRequest {
  workerId: string;
  port: number;
  publicProtocol?: PublicProtocol;
  publicUrl?: string;
  capacity: number;
  capabilities: WorkerCapability[];
}

export interface WorkerRegistrationResponse {
  workerId: string;
  heartbeatIntervalMs: number;
}

export interface ClientRegistrationRequest {
  clientId: string;
  type: ClientType;
  port: number;
  publicProtocol?: PublicProtocol;
  publicUrl?: string;
  callbackPath: string;
}

export interface ClientRegistrationResponse {
  clientId: string;
  callbackUrl: string;
  heartbeatIntervalMs: number;
}

export interface ClientHeartbeatRequest {
  clientId: string;
  status: ClientStatus;
}

export interface RegisteredClient {
  clientId: string;
  type: ClientType;
  baseUrl: string;
  callbackUrl: string;
  status: ClientStatus;
  registeredAt: string;
  lastHeartbeatAt: string;
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

export interface WorkerAssignmentPrepareRequest {
  jobId: string;
  workerId: string;
  sourceClientId: string;
  client: ClientRef;
  callbackUrl?: string;
  requiredCapabilities: string[];
  dispatchTokenExpiresAt: string;
  callbackToken?: string;
  callbackTokenExpiresAt?: string;
}

export interface WorkerAssignmentPrepareResponse {
  jobId: string;
  accepted: boolean;
  expiresAt: string;
}

export interface WorkerDispatchAssignment {
  workerId: string;
  baseUrl: string;
  jobUrl: string;
  dispatchToken: string;
  dispatchTokenExpiresAt: string;
}

export interface TryOnJobAssignmentResponse {
  job: TryOnJob;
  worker: WorkerDispatchAssignment;
  workerRequest: WorkerJobRequest;
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
    typeof value.sourceClientId === "string" &&
    value.sourceClientId.length > 0 &&
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
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    (value.publicProtocol === undefined ||
      value.publicProtocol === "http" ||
      value.publicProtocol === "https") &&
    (value.publicUrl === undefined ||
      (typeof value.publicUrl === "string" && value.publicUrl.length > 0)) &&
    typeof value.capacity === "number" &&
    value.capacity > 0 &&
    Array.isArray(value.capabilities)
  );
}

export function isClientRegistrationRequest(
  value: unknown,
): value is ClientRegistrationRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.clientId === "string" &&
    value.clientId.length > 0 &&
    value.type === "telegram" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    (value.publicProtocol === undefined ||
      value.publicProtocol === "http" ||
      value.publicProtocol === "https") &&
    (value.publicUrl === undefined ||
      (typeof value.publicUrl === "string" && value.publicUrl.length > 0)) &&
    typeof value.callbackPath === "string" &&
    value.callbackPath.startsWith("/")
  );
}

export function isClientHeartbeatRequest(
  value: unknown,
): value is ClientHeartbeatRequest {
  return (
    isObject(value) &&
    typeof value.clientId === "string" &&
    (value.status === "ready" || value.status === "offline")
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

export function isWorkerAssignmentPrepareRequest(
  value: unknown,
): value is WorkerAssignmentPrepareRequest {
  if (!isObject(value) || !isObject(value.client)) {
    return false;
  }

  return (
    typeof value.jobId === "string" &&
    typeof value.workerId === "string" &&
    typeof value.sourceClientId === "string" &&
    value.sourceClientId.length > 0 &&
    value.client.type === "telegram" &&
    typeof value.client.chatId === "string" &&
    (value.callbackUrl === undefined || typeof value.callbackUrl === "string") &&
    Array.isArray(value.requiredCapabilities) &&
    value.requiredCapabilities.every((capability) => typeof capability === "string") &&
    typeof value.dispatchTokenExpiresAt === "string" &&
    (value.callbackToken === undefined || typeof value.callbackToken === "string") &&
    (value.callbackTokenExpiresAt === undefined ||
      typeof value.callbackTokenExpiresAt === "string")
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
    return (
      value.result === undefined ||
      (isObject(value.result) && typeof value.result.message === "string")
    );
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
