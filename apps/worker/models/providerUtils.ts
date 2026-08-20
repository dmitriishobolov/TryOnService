import { Blob } from "node:buffer";
import { extname } from "node:path";

import type {
  StorageAccessAssignment,
  StorageObjectRef,
  TryOnJobResult,
  WorkerJobRequest,
} from "../../shared/contracts/index.js";
import { normalizeStorageKey } from "../../shared/storage/index.js";
import type { CoordinatorClient } from "../api/coordinatorClient.js";
import type { WorkerConfig } from "../config/index.js";
import type { DownloadedImage, TryOnInputFiles } from "./types.js";

type FetchBody = NonNullable<RequestInit["body"]>;

export class TryOnModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function requireApiKey(
  provider: string,
  envName: string,
  value: string | undefined,
): string {
  if (!value) {
    throw new TryOnModelError(
      `${provider}_api_key_missing`,
      `${envName} is required for ${provider}`,
      false,
    );
  }

  return value;
}

export function selectTryOnInputFiles(
  job: WorkerJobRequest,
  config: WorkerConfig,
): TryOnInputFiles {
  const files = job.payload.inputFiles ?? [];
  const requiredLength =
    Math.max(config.tryOnPersonImageIndex, config.tryOnGarmentImageIndex) + 1;

  if (files.length < requiredLength) {
    throw new TryOnModelError(
      "tryon_input_files_required",
      `TRYON_MODEL_PROVIDER=${config.tryOnModelProvider} requires person image at inputFiles[${config.tryOnPersonImageIndex}] and garment image at inputFiles[${config.tryOnGarmentImageIndex}]`,
      false,
    );
  }

  return {
    person: files[config.tryOnPersonImageIndex],
    garment: files[config.tryOnGarmentImageIndex],
  };
}

export function ensurePublicImageUrl(
  ref: StorageObjectRef,
  role: "person" | "garment",
  provider: string,
): string {
  if (ref.url) {
    return ref.url;
  }

  throw new TryOnModelError(
    `${provider}_public_${role}_url_required`,
    `${provider} requires a public ${role} image URL in StorageObjectRef.url`,
    false,
  );
}

export async function downloadInputImage(
  job: WorkerJobRequest,
  ref: StorageObjectRef,
  config: WorkerConfig,
  signal?: AbortSignal,
): Promise<DownloadedImage> {
  const access = resolveStorageAccess(job, ref);
  const response = await fetchWithTimeout(
    storageObjectDownloadUrl(ref, access),
    {
      method: "GET",
      headers: access ? { "x-storage-access-token": access.accessToken } : {},
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );

  if (!response.ok) {
    throw await providerResponseError("storage", response);
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType:
      response.headers.get("content-type") ??
      ref.contentType ??
      "application/octet-stream",
    filename: filenameFromStorageKey(ref.key),
  };
}

export function appendImageFile(
  form: FormData,
  field: string,
  image: DownloadedImage,
): void {
  form.append(
    field,
    new Blob([new Uint8Array(image.buffer)], {
      type: image.contentType,
    }),
    image.filename,
  );
}

export async function storeResultFromUrl(params: {
  provider: string;
  jobId: string;
  resultUrl: string;
  coordinator: CoordinatorClient;
  config: WorkerConfig;
  signal?: AbortSignal;
}): Promise<StorageObjectRef> {
  const response = await fetchWithTimeout(
    params.resultUrl,
    { method: "GET" },
    params.config.tryOnModelHttpTimeoutMs,
    params.signal,
  );

  if (!response.ok) {
    throw await providerResponseError(params.provider, response);
  }

  return storeResultFromResponse({
    provider: params.provider,
    jobId: params.jobId,
    response,
    coordinator: params.coordinator,
    config: params.config,
    signal: params.signal,
  });
}

export async function storeResultFromResponse(params: {
  provider: string;
  jobId: string;
  response: Response;
  coordinator: CoordinatorClient;
  config: WorkerConfig;
  signal?: AbortSignal;
}): Promise<StorageObjectRef> {
  if (!params.response.body) {
    throw new TryOnModelError(
      `${params.provider}_empty_result`,
      `${params.provider} returned an empty result body`,
      true,
    );
  }

  const contentType =
    params.response.headers.get("content-type") ?? "application/octet-stream";

  return putResultObject({
    provider: params.provider,
    jobId: params.jobId,
    body: params.response.body,
    contentType,
    coordinator: params.coordinator,
    config: params.config,
    signal: params.signal,
  });
}

export async function storeResultFromBuffer(params: {
  provider: string;
  jobId: string;
  buffer: Buffer;
  contentType: string;
  coordinator: CoordinatorClient;
  config: WorkerConfig;
  signal?: AbortSignal;
}): Promise<StorageObjectRef> {
  return putResultObject({
    provider: params.provider,
    jobId: params.jobId,
    body: params.buffer,
    contentType: params.contentType,
    coordinator: params.coordinator,
    config: params.config,
    signal: params.signal,
  });
}

export function createStoredResult(
  providerName: string,
  file: StorageObjectRef,
): TryOnJobResult {
  return {
    message: `Ответ от сервера. Провайдер: ${providerName}. Результат сохранен в storage: ${file.key}`,
    files: [file],
  };
}

export async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchWithTimeout(url, init, timeoutMs, signal);

  if (!response.ok) {
    throw await providerResponseError(provider, response);
  }

  return (await response.json()) as T;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    controller.abort();
  };

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function providerResponseError(
  provider: string,
  response: Response,
): Promise<TryOnModelError> {
  const raw = await response.text().catch(() => "");
  const parsed = parseJson(raw);
  const message =
    findStringByKeys(parsed, ["message", "detail", "error", "description"]) ??
    (raw.slice(0, 500) ||
      `${provider} request failed with status ${response.status}`);

  return new TryOnModelError(
    `${provider}_api_${response.status}`,
    `${provider} request failed with status ${response.status}: ${message}`,
    response.status === 429 || response.status >= 500,
  );
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;

  return `${base}${suffix}`;
}

export function apiKeyHeaders(
  headerName: string,
  apiKey: string,
  prefix?: string,
): Record<string, string> {
  return {
    [headerName]: prefix ? `${prefix} ${apiKey}` : apiKey,
  };
}

export function findStringByKeys(
  value: unknown,
  keys: string[],
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const current = value[key];

    if (typeof current === "string" && current.trim()) {
      return current;
    }
  }

  return undefined;
}

export function findFirstUrl(value: unknown): string | undefined {
  const preferred = [
    "result_url",
    "resultUrl",
    "resultURL",
    "url",
    "image_url",
    "imageUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
  ];
  const preferredValue = findNestedStringByKeys(value, preferred);

  if (preferredValue && isHttpUrl(preferredValue)) {
    return preferredValue;
  }

  return findNestedUrl(value, 0);
}

export function findFirstId(value: unknown, keys: string[]): string | undefined {
  const direct = findNestedStringByKeys(value, keys);

  return direct?.trim() || undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveStorageAccess(
  job: WorkerJobRequest,
  ref: StorageObjectRef,
): StorageAccessAssignment | undefined {
  if (!job.storage) {
    return undefined;
  }

  if (ref.storageId && ref.storageId !== job.storage.storageId) {
    return undefined;
  }

  return job.storage;
}

function storageObjectDownloadUrl(
  ref: StorageObjectRef,
  access: StorageAccessAssignment | undefined,
): string {
  if (access) {
    return `${access.objectBaseUrl.replace(/\/$/, "")}/${encodeStorageKey(ref.key)}`;
  }

  if (ref.url) {
    return ref.url;
  }

  throw new TryOnModelError(
    "storage_access_required",
    `Storage access is required to read ${ref.key}`,
    true,
  );
}

async function putResultObject(params: {
  provider: string;
  jobId: string;
  body: FetchBody;
  contentType: string;
  coordinator: CoordinatorClient;
  config: WorkerConfig;
  signal?: AbortSignal;
}): Promise<StorageObjectRef> {
  const prefix = normalizeStorageKey(`jobs/${params.jobId}/results`);
  const extension = extensionForContentType(params.contentType);
  const key = normalizeStorageKey(
    `${prefix}/${Date.now()}-${params.provider}${extension}`,
  );
  const { storage } = await params.coordinator.requestStorageAccess({
    scope: "read-write",
    keyPrefix: prefix,
  });
  const response = await fetchWithTimeout(
    `${storage.objectBaseUrl.replace(/\/$/, "")}/${encodeStorageKey(key)}`,
    {
      method: "PUT",
      headers: {
        "content-type": params.contentType,
        "x-storage-access-token": storage.accessToken,
      },
      body: params.body,
      duplex: "half",
    } as RequestInit,
    params.config.tryOnModelHttpTimeoutMs,
    params.signal,
  );

  if (!response.ok) {
    throw await providerResponseError("storage", response);
  }

  const payload = (await response.json()) as { object?: StorageObjectRef };

  if (!payload.object) {
    throw new TryOnModelError(
      "storage_put_invalid_response",
      "Storage did not return object metadata",
      true,
    );
  }

  return payload.object;
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  const mapped: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/octet-stream": ".bin",
  };

  return mapped[normalized] ?? ".bin";
}

function filenameFromStorageKey(key: string): string {
  const normalized = normalizeStorageKey(key);
  const filename = normalized.split("/").pop() ?? "image";

  return extname(filename) ? filename : `${filename}.png`;
}

function encodeStorageKey(key: string): string {
  return normalizeStorageKey(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function parseJson(raw: string): unknown {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function findNestedStringByKeys(
  value: unknown,
  keys: string[],
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedStringByKeys(item, keys);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const current = value[key];

    if (typeof current === "string" && current.trim()) {
      return current;
    }

    if (Array.isArray(current) || isRecord(current)) {
      const nested = findNestedStringByKeys(current, keys);

      if (nested) {
        return nested;
      }
    }
  }

  for (const current of Object.values(value)) {
    if (Array.isArray(current) || isRecord(current)) {
      const nested = findNestedStringByKeys(current, keys);

      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function findNestedUrl(value: unknown, depth: number): string | undefined {
  if (depth > 8) {
    return undefined;
  }

  if (typeof value === "string") {
    return isHttpUrl(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedUrl(item, depth + 1);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const current of Object.values(value)) {
    const found = findNestedUrl(current, depth + 1);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}
