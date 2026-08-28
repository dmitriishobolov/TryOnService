import { createHash } from "node:crypto";

import type {
  StorageAccessAssignment,
  StorageCatalogEntryUpsertRequest,
  StorageObjectRef,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import { normalizeStorageKey } from "../../shared/storage/index.js";
import type { CatalogCoordinatorClient } from "../api/coordinatorClient.js";
import type { CatalogIngestorConfig } from "../config/index.js";
import type { CatalogGarmentDraft, PublishedCatalogItem } from "./types.js";

interface ResolvedCatalogImage {
  body: Buffer;
  contentType: string;
  filename: string;
}

export class GarmentCatalogPublisher {
  constructor(
    private readonly config: CatalogIngestorConfig,
    private readonly coordinator: CatalogCoordinatorClient,
  ) {}

  async publish(draft: CatalogGarmentDraft): Promise<PublishedCatalogItem> {
    validateDraft(draft);

    const cacheKey = draft.cacheKey ?? buildCacheKey(draft);
    const keyPrefix = buildItemKeyPrefix(this.config.storagePrefix, draft, cacheKey);
    const storageAccess = await this.coordinator.requestStorageAccess({
      scope: "read-write",
      keyPrefix,
    });
    const image = await resolveCatalogImage(draft, this.config);
    const objectKey = `${keyPrefix}/${image.filename}`;
    const object = await putStorageObject(
      storageAccess.storage,
      objectKey,
      image,
      this.config,
    );

    await postJson(
      `${storageAccess.storage.baseUrl}/catalog/entries`,
      buildCatalogEntryUpsert(draft, cacheKey, object.key),
      {
        "x-storage-access-token": storageAccess.storage.accessToken,
      },
      {
        retries: this.config.httpClientRetries,
        timeoutMs: this.config.httpClientTimeoutMs,
      },
    );

    return {
      cacheKey,
      provider: draft.provider,
      object,
    };
  }
}

function validateDraft(draft: CatalogGarmentDraft): void {
  if (!draft.provider || !draft.externalId || !draft.productUrl) {
    throw new Error("Catalog garment draft must contain provider, externalId and productUrl");
  }

  if (!draft.title || !draft.category) {
    throw new Error("Catalog garment draft must contain title and category");
  }

  if (!draft.image.url && !draft.image.data) {
    throw new Error("Catalog garment draft must contain image.url or image.data");
  }
}

function buildCatalogEntryUpsert(
  draft: CatalogGarmentDraft,
  cacheKey: string,
  objectKey: string,
): StorageCatalogEntryUpsertRequest {
  return {
    entry: {
      cacheKey,
      kind: "garment-item",
      objectKey,
      metadata: {
        ...draft.metadata,
        provider: draft.provider,
        externalId: draft.externalId,
        productUrl: draft.productUrl,
        title: draft.title,
        category: draft.category,
        description: draft.description,
        tags: uniqueStrings(draft.tags ?? []),
        colorTags: uniqueStrings(draft.colorTags ?? []),
        styleTags: uniqueStrings(draft.styleTags ?? []),
        materialTags: uniqueStrings(draft.materialTags ?? []),
        price: draft.price,
        currency: draft.currency,
        store: draft.store,
      },
    },
  };
}

async function resolveCatalogImage(
  draft: CatalogGarmentDraft,
  config: CatalogIngestorConfig,
): Promise<ResolvedCatalogImage> {
  if (draft.image.data) {
    const body = Buffer.from(draft.image.data);

    if (body.byteLength > config.maxImageBytes) {
      throw new Error(`Catalog image exceeds ${config.maxImageBytes} bytes`);
    }

    return {
      body,
      contentType: draft.image.contentType ?? contentTypeFromFilename(draft.image.filename),
      filename: sanitizeFilename(draft.image.filename ?? "product-image.jpg"),
    };
  }

  if (!draft.image.url) {
    throw new Error("Catalog image URL is missing");
  }

  const response = await fetchWithTimeout(
    draft.image.url,
    {
      method: "GET",
      headers: {
        "user-agent": config.userAgent,
      },
    },
    config.imageDownloadTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Catalog image download failed with ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);

  if (contentLength > config.maxImageBytes) {
    throw new Error(`Catalog image exceeds ${config.maxImageBytes} bytes`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength > config.maxImageBytes) {
    throw new Error(`Catalog image exceeds ${config.maxImageBytes} bytes`);
  }

  const contentType =
    response.headers.get("content-type") ??
    draft.image.contentType ??
    contentTypeFromFilename(draft.image.url);

  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Catalog image response is not an image: ${contentType}`);
  }

  return {
    body: buffer,
    contentType,
    filename: sanitizeFilename(
      draft.image.filename ?? filenameFromUrl(draft.image.url) ?? "product-image.jpg",
    ),
  };
}

async function putStorageObject(
  storage: StorageAccessAssignment,
  objectKey: string,
  image: ResolvedCatalogImage,
  config: CatalogIngestorConfig,
): Promise<StorageObjectRef> {
  const response = await fetchWithTimeout(
    storageObjectUrl(storage.objectBaseUrl, objectKey),
    {
      method: "PUT",
      headers: {
        "content-type": image.contentType,
        "x-storage-access-token": storage.accessToken,
      },
      body: image.body,
    },
    config.imageDownloadTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Storage upload failed with ${response.status}`);
  }

  const payload = (await response.json()) as { object?: StorageObjectRef };

  if (!payload.object) {
    throw new Error("Storage upload response did not contain object metadata");
  }

  return payload.object;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildCacheKey(draft: CatalogGarmentDraft): string {
  const stableId = draft.productUrl || draft.externalId;
  const hash = createHash("sha256").update(stableId).digest("hex").slice(0, 16);

  return `garment:${draft.provider}:${sanitizeSegment(draft.externalId)}:${hash}`;
}

function buildItemKeyPrefix(
  rootPrefix: string,
  draft: CatalogGarmentDraft,
  cacheKey: string,
): string {
  return normalizeStorageKey(
    [
      rootPrefix,
      sanitizeSegment(draft.provider),
      sanitizeSegment(draft.category),
      sanitizeSegment(cacheKey),
    ].join("/"),
  );
}

function storageObjectUrl(objectBaseUrl: string, key: string): string {
  return `${objectBaseUrl.replace(/\/$/, "")}/${encodeStorageKey(key)}`;
}

function encodeStorageKey(key: string): string {
  return key
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function filenameFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const filename = url.pathname.split("/").filter(Boolean).at(-1);

    return filename || undefined;
  } catch {
    return undefined;
  }
}

function contentTypeFromFilename(filename: string | undefined): string {
  const extension = filename?.split(".").pop()?.toLowerCase();

  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }

  if (extension === "png") {
    return "image/png";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  return "image/jpeg";
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");

  return sanitized || "product-image.jpg";
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "unknown";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}