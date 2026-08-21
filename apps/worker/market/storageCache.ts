import { createHash } from "node:crypto";

import {
  isMarketProductRef,
  type MarketProductRef,
  type MarketSearchSelection,
  type WorkerJobRequest,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
import { normalizeStorageKey } from "../../shared/storage/index.js";
import type { CoordinatorClient } from "../api/coordinatorClient.js";
import type { WorkerConfig } from "../config/index.js";

const logger = createLogger("worker");

interface MarketSearchCachePayload {
  version: 1;
  cacheKey: string;
  cachedAt: string;
  expiresAt: string;
  selection: MarketSearchSelection;
  products: MarketProductRef[];
}

export async function readCachedMarketplaceProducts(params: {
  job: WorkerJobRequest;
  config: WorkerConfig;
  coordinator: CoordinatorClient;
}): Promise<MarketProductRef[] | undefined> {
  if (!params.config.market.storageCacheEnabled || !params.job.payload.market) {
    return undefined;
  }

  const cacheKey = createMarketSearchCacheKey(
    params.job.payload.market,
    params.job.payload.text,
  );

  try {
    const lookup = await params.coordinator.lookupStorageCatalog({
      cacheKeys: [cacheKey],
      kinds: ["market-search"],
    });

    for (const location of lookup.locations) {
      if (!location.objectUrl) {
        continue;
      }

      const response = await fetchWithTimeout(
        location.objectUrl,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        },
        params.config.httpClientTimeoutMs,
      );

      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }

      const payload = (await response.json()) as Partial<MarketSearchCachePayload>;
      const products = Array.isArray(payload.products)
        ? payload.products.filter(isMarketProductRef)
        : [];

      if (payload.expiresAt && Date.now() > new Date(payload.expiresAt).getTime()) {
        continue;
      }

      if (products.length > 0) {
        const limit =
          params.job.payload.market.limit ?? params.config.market.searchLimit;

        logger.info("Marketplace storage cache hit", {
          jobId: params.job.jobId,
          cacheKey,
          storageId: location.storageId,
          products: products.length,
        });

        return products.slice(0, limit);
      }
    }
  } catch (error) {
    logger.warn("Marketplace storage cache lookup failed", {
      jobId: params.job.jobId,
      cacheKey,
      error,
    });
  }

  return undefined;
}

export async function writeCachedMarketplaceProducts(params: {
  job: WorkerJobRequest;
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  products: MarketProductRef[];
}): Promise<void> {
  if (
    !params.config.market.storageCacheEnabled ||
    !params.job.payload.market ||
    params.products.length === 0
  ) {
    return;
  }

  const cacheKey = createMarketSearchCacheKey(
    params.job.payload.market,
    params.job.payload.text,
  );
  const hash = hashCacheKey(cacheKey);
  const keyPrefix = `workers/${sanitizeStorageRequesterId(
    params.config.workerId,
  )}/market-cache/${hash.slice(0, 2)}`;
  const objectKey = normalizeStorageKey(`${keyPrefix}/${hash}.json`);
  const expiresAt = new Date(
    Date.now() + params.config.market.storageCacheTtlMs,
  ).toISOString();

  try {
    const { storage } = await params.coordinator.requestStorageAccess({
      scope: "read-write",
      keyPrefix,
    });
    const payload: MarketSearchCachePayload = {
      version: 1,
      cacheKey,
      cachedAt: new Date().toISOString(),
      expiresAt,
      selection: params.job.payload.market,
      products: params.products,
    };
    const upload = await fetchWithTimeout(
      storageObjectUrl(storage.objectBaseUrl, objectKey),
      {
        method: "PUT",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-storage-access-token": storage.accessToken,
        },
        body: JSON.stringify(payload),
      },
      params.config.httpClientTimeoutMs,
    );

    if (!upload.ok) {
      await upload.body?.cancel();
      throw new Error(`Marketplace storage cache upload failed with ${upload.status}`);
    }

    await upsertStorageCatalogEntry(params.config, storage, {
      cacheKey,
      kind: "market-search",
      objectKey,
      expiresAt,
      metadata: {
        products: params.products.length,
        providers: [...new Set(params.products.map((product) => product.provider))],
        query: params.job.payload.market.query ?? params.job.payload.text,
      },
    });

    await Promise.allSettled(
      params.products
        .filter((product) => product.productUrl)
        .map((product) =>
          upsertStorageCatalogEntry(params.config, storage, {
            cacheKey: createMarketProductCacheKey(product.productUrl ?? ""),
            kind: "market-product",
            objectKey,
            expiresAt,
            metadata: {
              product,
              searchCacheKey: cacheKey,
            },
          }),
        ),
    );

    logger.info("Marketplace storage cache written", {
      jobId: params.job.jobId,
      cacheKey,
      storageId: storage.storageId,
      objectKey,
      products: params.products.length,
    });
  } catch (error) {
    logger.warn("Marketplace storage cache write failed", {
      jobId: params.job.jobId,
      cacheKey,
      objectKey,
      error,
    });
  }
}

export function createMarketSearchCacheKey(
  selection: MarketSearchSelection,
  fallbackQuery?: string,
): string {
  const normalized = {
    providers: [...(selection.providers ?? [])].sort(),
    query: normalizeCacheValue(selection.query ?? fallbackQuery ?? ""),
    limit: selection.limit,
    category: normalizeCacheValue(selection.category ?? ""),
    categoryIds: [...(selection.categoryIds ?? [])].sort(),
    minPrice: selection.minPrice,
    maxPrice: selection.maxPrice,
    currency: normalizeCacheValue(selection.currency ?? "rub"),
    locale: normalizeCacheValue(selection.locale ?? "ru"),
    country: normalizeCacheValue(selection.country ?? "ru"),
    sort: normalizeCacheValue(selection.sort ?? ""),
  };

  return `market-search:${hashCacheKey(JSON.stringify(normalized))}`;
}

export function createMarketProductCacheKey(productUrl: string): string {
  return `market-product:${hashCacheKey(canonicalProductUrlForCache(productUrl))}`;
}

async function upsertStorageCatalogEntry(
  config: WorkerConfig,
  storage: {
    baseUrl: string;
    accessToken: string;
  },
  entry: {
    cacheKey: string;
    kind: "market-search" | "market-product";
    objectKey: string;
    metadata: Record<string, unknown>;
    expiresAt: string;
  },
): Promise<void> {
  await postJson(
    `${storage.baseUrl}/catalog/entries`,
    {
      entry,
    },
    {
      "x-storage-access-token": storage.accessToken,
    },
    {
      retries: config.httpClientRetries,
      timeoutMs: config.httpClientTimeoutMs,
    },
  );
}

function hashCacheKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeStorageRequesterId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function normalizeCacheValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function canonicalProductUrlForCache(value: string): string {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    const searchParams = [...url.searchParams.entries()]
      .filter(([key]) => !isTrackingSearchParam(key))
      .sort(([keyA, valueA], [keyB, valueB]) =>
        keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
      );

    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";

    for (const [key, paramValue] of searchParams) {
      url.searchParams.append(key, paramValue);
    }

    return url.toString();
  } catch {
    return trimmed.replace(/\s+/g, " ");
  }
}

function isTrackingSearchParam(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    normalized.startsWith("utm_") ||
    [
      "fbclid",
      "gclid",
      "gbraid",
      "yclid",
      "wbraid",
      "msclkid",
      "spm",
      "scm",
      "algo_pvid",
      "click_id",
      "clickid",
    ].includes(normalized)
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
