export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_TIMEOUT_MS = 15_000;
export const CLIENT_HEARTBEAT_INTERVAL_MS = 5_000;
export const CLIENT_HEARTBEAT_TIMEOUT_MS = 15_000;
export const STORAGE_HEARTBEAT_INTERVAL_MS = 5_000;
export const STORAGE_HEARTBEAT_TIMEOUT_MS = 15_000;

export type ClientType = "telegram";
export type ClientStatus = "ready" | "offline";

export type JobStatus =
  | "queued"
  | "assigned"
  | "running"
  | "succeeded"
  | "delivery_failed"
  | "failed"
  | "cancelled";

export type WorkerStatus = "ready" | "busy" | "offline";
export type StorageStatus = "ready" | "offline";
export type StorageAccessScope = "read" | "write" | "read-write";
export type TryOnModelProvider =
  | "mock"
  | "pruna"
  | "pixelcut"
  | "tryoncloud"
  | "genlook"
  | "wearfits"
  | "openai";
export type TryOnModelTask =
  | "try-on"
  | "appearance-analysis"
  | "ideal-outfit";

export interface TelegramClientRef {
  type: "telegram";
  chatId: string;
  username?: string;
}

export type ClientRef = TelegramClientRef;

export type StorageObjectDriver = "local" | "s3";

export interface StorageObjectRef {
  driver: StorageObjectDriver;
  storageId?: string;
  key: string;
  bucket?: string;
  contentType?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  url?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface StorageRegistrationRequest {
  storageId: string;
  port: number;
  publicProtocol?: PublicProtocol;
  publicUrl?: string;
  driver: StorageObjectDriver;
  capacityBytes?: number;
}

export interface StorageRegistrationResponse {
  storageId: string;
  heartbeatIntervalMs: number;
}

export interface StorageHeartbeatRequest {
  storageId: string;
  status: StorageStatus;
  usedBytes?: number;
  capacityBytes?: number;
}

export interface RegisteredStorageNode {
  storageId: string;
  baseUrl: string;
  driver: StorageObjectDriver;
  status: StorageStatus;
  usedBytes?: number;
  capacityBytes?: number;
  registeredAt: string;
  lastHeartbeatAt: string;
}

export interface StorageAccessRequest {
  requesterId: string;
  requesterType: "client" | "worker";
  scope: StorageAccessScope;
  storageId?: string;
  keyPrefix?: string;
}

export interface StorageAccessAssignment {
  storageId: string;
  baseUrl: string;
  objectBaseUrl: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  scope: StorageAccessScope;
  keyPrefix?: string;
}

export interface StorageAccessResponse {
  storage: StorageAccessAssignment;
}

export type StorageCatalogEntryKind =
  | "product-card-image"
  | "product-card-metadata"
  | "garment-item";

export interface StorageCatalogEntry {
  cacheKey: string;
  kind: StorageCatalogEntryKind;
  object: StorageObjectRef;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface StorageCatalogEntryInput {
  cacheKey: string;
  kind: StorageCatalogEntryKind;
  objectKey: string;
  metadata?: Record<string, unknown>;
  expiresAt?: string;
}

export interface StorageCatalogEntryUpsertRequest {
  entry: StorageCatalogEntryInput;
}

export interface StorageCatalogNodeLookupRequest {
  cacheKeys: string[];
  kinds?: StorageCatalogEntryKind[];
}

export interface StorageCatalogNodeLookupResponse {
  entries: StorageCatalogEntry[];
}

export interface StorageCatalogLookupRequest {
  requesterId: string;
  requesterType: "client" | "worker";
  cacheKeys: string[];
  kinds?: StorageCatalogEntryKind[];
}

export interface StorageCatalogLocation {
  storageId: string;
  baseUrl: string;
  entry: StorageCatalogEntry;
  storage?: StorageAccessAssignment;
  objectUrl?: string;
}

export interface StorageCatalogLookupResponse {
  locations: StorageCatalogLocation[];
}

export interface GarmentCatalogCategory {
  name: string;
  count: number;
}

export interface GarmentCatalogCategoriesRequest {
  requesterId: string;
  requesterType: "client" | "worker";
}

export interface GarmentCatalogCategoriesResponse {
  categories: GarmentCatalogCategory[];
}

export interface GarmentCatalogNodeSearchRequest {
  categories?: string[];
  tags?: string[];
  text?: string;
  limit?: number;
}

export interface GarmentCatalogSearchRequest extends GarmentCatalogNodeSearchRequest {
  requesterId: string;
  requesterType: "client" | "worker";
}

export interface GarmentCatalogItem {
  id: string;
  cacheKey: string;
  storageId: string;
  category: string;
  title: string;
  description?: string;
  tags: string[];
  price?: string;
  currency?: string;
  store?: string;
  productUrl?: string;
  image: StorageObjectRef;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface GarmentCatalogSearchResponse {
  items: GarmentCatalogItem[];
}

export interface TryOnModelSelection {
  provider: TryOnModelProvider;
  task?: TryOnModelTask;
  providerModel?: string;
  options?: Record<string, unknown>;
}

export interface CreateTryOnJobRequest {
  sourceClientId: string;
  client: ClientRef;
  payload: {
    command: "request";
    model?: TryOnModelSelection;
    text?: string;
    inputFiles?: StorageObjectRef[];
  };
  callbackUrl?: string;
}

export interface JobCancelRequest {
  sourceClientId: string;
  reason?: string;
}

export interface TryOnJobResult {
  message: string;
  files?: StorageObjectRef[];
  garments?: GarmentCatalogItem[];
  nextInput?: {
    type: "photo";
    message: string;
  };
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
  storage?: StorageAccessAssignment;
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
  storage?: StorageAccessAssignment;
  workerRequest: WorkerJobRequest;
}

export interface TryOnJobQueuedResponse {
  job: TryOnJob;
  queued: true;
  retryAfterMs: number;
  reason?: string;
}

export interface JobCancelResponse {
  ok: true;
  job: TryOnJob;
  cancelled: boolean;
}

export type TryOnJobCreateResponse =
  | TryOnJobAssignmentResponse
  | TryOnJobQueuedResponse;

export interface WorkerJobAcceptedResponse {
  jobId: string;
  accepted: boolean;
}

export interface WorkerJobCancelResponse {
  ok: true;
  jobId: string;
  cancelledPending: boolean;
  cancelledRunning: boolean;
  runningCancellationSupported: boolean;
}

export interface JobProgressUpdateRequest {
  jobId: string;
  status: Extract<JobStatus, "running">;
  message?: string;
}

export interface JobResultUpdateRequest {
  jobId: string;
  status: Extract<JobStatus, "succeeded" | "delivery_failed" | "failed" | "cancelled">;
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
    (payload.model === undefined || isTryOnModelSelection(payload.model)) &&
    (payload.inputFiles === undefined ||
      (Array.isArray(payload.inputFiles) &&
        payload.inputFiles.every(isStorageObjectRef))) &&
    (value.callbackUrl === undefined || typeof value.callbackUrl === "string")
  );
}

export function isJobCancelRequest(value: unknown): value is JobCancelRequest {
  return (
    isObject(value) &&
    typeof value.sourceClientId === "string" &&
    value.sourceClientId.length > 0 &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

export function isTryOnModelSelection(value: unknown): value is TryOnModelSelection {
  if (!isObject(value)) {
    return false;
  }

  return (
    isTryOnModelProvider(value.provider) &&
    (value.task === undefined || isTryOnModelTask(value.task)) &&
    (value.providerModel === undefined ||
      (typeof value.providerModel === "string" &&
        value.providerModel.length > 0)) &&
    (value.options === undefined || isObject(value.options))
  );
}

export function isTryOnModelProvider(
  value: unknown,
): value is TryOnModelProvider {
  return (
    value === "mock" ||
    value === "pruna" ||
    value === "pixelcut" ||
    value === "tryoncloud" ||
    value === "genlook" ||
    value === "wearfits" ||
    value === "openai"
  );
}

function isTryOnModelTask(value: unknown): value is TryOnModelTask {
  return (
    value === "try-on" ||
    value === "appearance-analysis" ||
    value === "ideal-outfit"
  );
}

export function isStorageObjectRef(value: unknown): value is StorageObjectRef {
  if (!isObject(value)) {
    return false;
  }

  return (
    (value.driver === "local" || value.driver === "s3") &&
    (value.storageId === undefined || typeof value.storageId === "string") &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    (value.bucket === undefined || typeof value.bucket === "string") &&
    (value.contentType === undefined ||
      typeof value.contentType === "string") &&
    (value.sizeBytes === undefined ||
      (typeof value.sizeBytes === "number" && value.sizeBytes >= 0)) &&
    (value.checksumSha256 === undefined ||
      typeof value.checksumSha256 === "string") &&
    (value.url === undefined || typeof value.url === "string") &&
    (value.createdAt === undefined || typeof value.createdAt === "string") &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string")
  );
}

export function isStorageRegistrationRequest(
  value: unknown,
): value is StorageRegistrationRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.storageId === "string" &&
    value.storageId.length > 0 &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    (value.publicProtocol === undefined ||
      value.publicProtocol === "http" ||
      value.publicProtocol === "https") &&
    (value.publicUrl === undefined ||
      (typeof value.publicUrl === "string" && value.publicUrl.length > 0)) &&
    (value.driver === "local" || value.driver === "s3") &&
    (value.capacityBytes === undefined ||
      (typeof value.capacityBytes === "number" && value.capacityBytes > 0))
  );
}

export function isStorageHeartbeatRequest(
  value: unknown,
): value is StorageHeartbeatRequest {
  return (
    isObject(value) &&
    typeof value.storageId === "string" &&
    (value.status === "ready" || value.status === "offline") &&
    (value.usedBytes === undefined ||
      (typeof value.usedBytes === "number" && value.usedBytes >= 0)) &&
    (value.capacityBytes === undefined ||
      (typeof value.capacityBytes === "number" && value.capacityBytes > 0))
  );
}

export function isStorageAccessRequest(
  value: unknown,
): value is StorageAccessRequest {
  return (
    isObject(value) &&
    typeof value.requesterId === "string" &&
    value.requesterId.length > 0 &&
    (value.requesterType === "client" || value.requesterType === "worker") &&
    (value.scope === "read" ||
      value.scope === "write" ||
      value.scope === "read-write") &&
    (value.storageId === undefined || typeof value.storageId === "string") &&
    (value.keyPrefix === undefined || typeof value.keyPrefix === "string")
  );
}

export function isStorageCatalogEntryKind(
  value: unknown,
): value is StorageCatalogEntryKind {
  return (
    value === "product-card-image" ||
    value === "product-card-metadata" ||
    value === "garment-item"
  );
}

export function isStorageCatalogEntry(value: unknown): value is StorageCatalogEntry {
  return (
    isObject(value) &&
    typeof value.cacheKey === "string" &&
    value.cacheKey.length > 0 &&
    isStorageCatalogEntryKind(value.kind) &&
    isStorageObjectRef(value.object) &&
    (value.metadata === undefined || isObject(value.metadata)) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string")
  );
}

export function isStorageCatalogEntryUpsertRequest(
  value: unknown,
): value is StorageCatalogEntryUpsertRequest {
  if (!isObject(value) || !isObject(value.entry)) {
    return false;
  }

  const { entry } = value;

  return (
    typeof entry.cacheKey === "string" &&
    entry.cacheKey.length > 0 &&
    isStorageCatalogEntryKind(entry.kind) &&
    typeof entry.objectKey === "string" &&
    entry.objectKey.length > 0 &&
    (entry.metadata === undefined || isObject(entry.metadata)) &&
    (entry.expiresAt === undefined || typeof entry.expiresAt === "string")
  );
}

export function isStorageCatalogNodeLookupRequest(
  value: unknown,
): value is StorageCatalogNodeLookupRequest {
  return (
    isObject(value) &&
    Array.isArray(value.cacheKeys) &&
    value.cacheKeys.length > 0 &&
    value.cacheKeys.length <= 100 &&
    value.cacheKeys.every(
      (cacheKey) => typeof cacheKey === "string" && cacheKey.length > 0,
    ) &&
    (value.kinds === undefined ||
      (Array.isArray(value.kinds) &&
        value.kinds.every(isStorageCatalogEntryKind)))
  );
}

export function isStorageCatalogLookupRequest(
  value: unknown,
): value is StorageCatalogLookupRequest {
  return (
    isObject(value) &&
    isStorageCatalogNodeLookupRequest(value) &&
    typeof value.requesterId === "string" &&
    value.requesterId.length > 0 &&
    (value.requesterType === "client" || value.requesterType === "worker")
  );
}

export function isGarmentCatalogCategoriesRequest(
  value: unknown,
): value is GarmentCatalogCategoriesRequest {
  return (
    isObject(value) &&
    typeof value.requesterId === "string" &&
    value.requesterId.length > 0 &&
    (value.requesterType === "client" || value.requesterType === "worker")
  );
}

export function isGarmentCatalogNodeSearchRequest(
  value: unknown,
): value is GarmentCatalogNodeSearchRequest {
  return (
    isObject(value) &&
    (value.categories === undefined ||
      isNonEmptyStringArray(value.categories, 50)) &&
    (value.tags === undefined || isNonEmptyStringArray(value.tags, 100)) &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.limit === undefined ||
      (typeof value.limit === "number" &&
        Number.isInteger(value.limit) &&
        value.limit > 0 &&
        value.limit <= 100))
  );
}

export function isGarmentCatalogSearchRequest(
  value: unknown,
): value is GarmentCatalogSearchRequest {
  return (
    isObject(value) &&
    isGarmentCatalogNodeSearchRequest(value) &&
    typeof value.requesterId === "string" &&
    value.requesterId.length > 0 &&
    (value.requesterType === "client" || value.requesterType === "worker")
  );
}

export function isGarmentCatalogItem(value: unknown): value is GarmentCatalogItem {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.cacheKey === "string" &&
    value.cacheKey.length > 0 &&
    typeof value.storageId === "string" &&
    value.storageId.length > 0 &&
    typeof value.category === "string" &&
    value.category.length > 0 &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.price === undefined || typeof value.price === "string") &&
    (value.currency === undefined || typeof value.currency === "string") &&
    (value.store === undefined || typeof value.store === "string") &&
    (value.productUrl === undefined || typeof value.productUrl === "string") &&
    isStorageObjectRef(value.image) &&
    (value.imageUrl === undefined || typeof value.imageUrl === "string") &&
    (value.metadata === undefined || isObject(value.metadata))
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
    value.payload.command === "request" &&
    (value.payload.model === undefined ||
      isTryOnModelSelection(value.payload.model)) &&
    (value.payload.inputFiles === undefined ||
      (Array.isArray(value.payload.inputFiles) &&
        value.payload.inputFiles.every(isStorageObjectRef)))
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

  if (value.status === "succeeded" || value.status === "delivery_failed") {
    return (
      isObject(value.result) &&
        typeof value.result.message === "string" &&
        (value.result.files === undefined ||
          (Array.isArray(value.result.files) &&
            value.result.files.every(isStorageObjectRef))) &&
      (value.result.garments === undefined ||
          (Array.isArray(value.result.garments) &&
            value.result.garments.every(isGarmentCatalogItem))) &&
        (value.result.nextInput === undefined ||
          (isObject(value.result.nextInput) &&
            value.result.nextInput.type === "photo" &&
            typeof value.result.nextInput.message === "string")) &&
      (value.status === "succeeded" ||
        (isObject(value.error) && typeof value.error.message === "string"))
    );
  }

  if (value.status === "failed" || value.status === "cancelled") {
    return (
      value.error === undefined ||
      (isObject(value.error) && typeof value.error.message === "string")
    );
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
    typeof value.result.message === "string" &&
    (value.result.files === undefined ||
      (Array.isArray(value.result.files) &&
        value.result.files.every(isStorageObjectRef))) &&
    (value.result.garments === undefined ||
      (Array.isArray(value.result.garments) &&
        value.result.garments.every(isGarmentCatalogItem))) &&
    (value.result.nextInput === undefined ||
      (isObject(value.result.nextInput) &&
        value.result.nextInput.type === "photo" &&
        typeof value.result.nextInput.message === "string"))
  );
}

function isNonEmptyStringArray(value: unknown, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}
