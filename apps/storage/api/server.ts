import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { pipeline } from "node:stream/promises";

import {
  isGarmentCatalogNodeSearchRequest,
  isStorageCatalogEntryUpsertRequest,
  isStorageCatalogNodeLookupRequest,
} from "../../shared/contracts/index.js";
import { verifyDispatchToken } from "../../shared/dispatchToken.js";
import {
  requestUrl,
  readJsonBody,
  writeCaughtError,
  writeError,
  writeJson,
} from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
import { FixedWindowRateLimiter } from "../../shared/rateLimit.js";
import {
  normalizeStorageKey,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type ObjectStorage,
} from "../../shared/storage/index.js";
import type { StorageConfig } from "../config/index.js";
import type { StorageCatalogIndex } from "../catalog/index.js";

const logger = createLogger("storage");

interface StorageServerDeps {
  config: StorageConfig;
  objects: ObjectStorage;
  catalog: StorageCatalogIndex;
  getUsedBytes: () => Promise<number | undefined>;
}

export function createStorageServer(deps: StorageServerDeps): Server {
  const { config, objects, catalog, getUsedBytes } = deps;
  const rateLimiter = new FixedWindowRateLimiter(
    config.apiRateLimitMaxRequests,
    config.apiRateLimitWindowMs,
  );
  setInterval(() => {
    rateLimiter.cleanup();
  }, config.apiRateLimitWindowMs).unref();

  return createServer(async (request, response) => {
    const url = requestUrl(request);
    const rateLimit = rateLimiter.consume(
      request.socket.remoteAddress ?? "unknown",
    );

    try {
      if (!rateLimit.allowed) {
        writeError(response, 429, "rate_limited", "Too many requests");
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        if (!hasStorageServiceKey(request.headers, config)) {
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        writeJson(response, 200, {
          status: "ok",
          storageId: config.storageId,
          driver: config.driver,
          usedBytes: await getUsedBytes(),
          capacityBytes: config.capacityBytes,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/catalog/lookup") {
        if (!hasStorageServiceKey(request.headers, config)) {
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isStorageCatalogNodeLookupRequest(body)) {
          writeError(
            response,
            400,
            "invalid_storage_catalog_lookup",
            "Invalid storage catalog lookup payload",
          );
          return;
        }

        const entries = await catalog.lookup(body);

        writeJson(response, 200, {
          entries,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/catalog/garments/categories") {
        if (!hasStorageServiceKey(request.headers, config)) {
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        writeJson(response, 200, {
          categories: await catalog.garmentCategories(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/catalog/garments/search") {
        if (!hasStorageServiceKey(request.headers, config)) {
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isGarmentCatalogNodeSearchRequest(body)) {
          writeError(
            response,
            400,
            "invalid_garment_catalog_search",
            "Invalid garment catalog search payload",
          );
          return;
        }

        writeJson(response, 200, {
          items: await catalog.searchGarments(body),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/catalog/entries") {
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isStorageCatalogEntryUpsertRequest(body)) {
          writeError(
            response,
            400,
            "invalid_storage_catalog_entry",
            "Invalid storage catalog entry payload",
          );
          return;
        }

        const key = normalizeStorageKey(body.entry.objectKey);

        if (!hasStorageObjectAccess(request.headers, config, key, "write")) {
          logger.warn("Storage catalog entry upsert rejected", {
            storageId: config.storageId,
            key,
            cacheKey: body.entry.cacheKey,
            kind: body.entry.kind,
            remoteAddress: request.socket.remoteAddress,
          });
          writeError(
            response,
            401,
            "unauthorized_storage_catalog",
            "Invalid storage access token",
          );
          return;
        }

        const entry = await catalog.upsert({
          ...body.entry,
          objectKey: key,
        });

        logger.info("Storage catalog entry upserted", {
          storageId: config.storageId,
          key,
          cacheKey: entry.cacheKey,
          kind: entry.kind,
        });

        writeJson(response, 201, {
          entry,
        });
        return;
      }

      const objectMatch = /^\/objects\/(.+)$/.exec(url.pathname);

      if (objectMatch && request.method === "PUT") {
        const key = normalizeStorageKey(decodeURIComponent(objectMatch[1]));

        if (!hasStorageObjectAccess(request.headers, config, key, "write")) {
          logger.warn("Storage object upload rejected", {
            storageId: config.storageId,
            key,
            remoteAddress: request.socket.remoteAddress,
          });
          writeError(
            response,
            401,
            "unauthorized_storage_object",
            "Invalid storage access token",
          );
          return;
        }

        logger.info("Storage object upload started", {
          storageId: config.storageId,
          key,
          contentType: firstHeaderValue(request.headers["content-type"]),
          contentLength: firstHeaderValue(request.headers["content-length"]),
        });
        const object = await objects.putObject({
          key,
          contentType: firstHeaderValue(request.headers["content-type"]),
          body: request,
          maxBytes: config.maxObjectBytes,
        });

        logger.info("Storage object upload finished", {
          storageId: config.storageId,
          key: object.key,
          contentType: object.contentType,
          sizeBytes: object.sizeBytes,
          driver: object.driver,
        });
        writeJson(response, 201, {
          object: {
            ...object,
            storageId: config.storageId,
          },
        });
        return;
      }

      if (objectMatch && request.method === "GET") {
        const key = normalizeStorageKey(decodeURIComponent(objectMatch[1]));

        if (
          !hasStorageObjectAccess(
            request.headers,
            config,
            key,
            "read",
            url.searchParams.get("accessToken") ?? undefined,
          )
        ) {
          logger.warn("Storage object download rejected", {
            storageId: config.storageId,
            key,
            remoteAddress: request.socket.remoteAddress,
          });
          writeError(
            response,
            401,
            "unauthorized_storage_object",
            "Invalid storage access token",
          );
          return;
        }

        const object = await objects.getObject(key);
        logger.info("Storage object download started", {
          storageId: config.storageId,
          key,
          contentType:
            object.contentType ??
            object.ref.contentType ??
            "application/octet-stream",
          sizeBytes: object.sizeBytes,
        });

        response.writeHead(200, {
          "Content-Type":
            object.contentType ??
            object.ref.contentType ??
            "application/octet-stream",
          ...(object.sizeBytes !== undefined
            ? { "Content-Length": object.sizeBytes }
            : {}),
        });
        await pipeline(object.stream, response);
        logger.info("Storage object download finished", {
          storageId: config.storageId,
          key,
          sizeBytes: object.sizeBytes,
        });
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        writeError(
          response,
          404,
          "object_not_found",
          `Storage object not found: ${error.key}`,
        );
        return;
      }

      if (error instanceof StorageObjectTooLargeError) {
        writeError(
          response,
          413,
          "object_too_large",
          `Storage object exceeds ${error.maxBytes} bytes`,
        );
        return;
      }

      logger.error("Unhandled storage request error", {
        method: request.method,
        path: url.pathname,
        error,
      });
      writeCaughtError(response, error);
    }
  });
}

function hasStorageServiceKey(
  headers: IncomingHttpHeaders,
  config: StorageConfig,
): boolean {
  return firstHeaderValue(headers["x-storage-service-key"]) === config.serviceKey;
}

function hasStorageObjectAccess(
  headers: IncomingHttpHeaders,
  config: StorageConfig,
  key: string,
  operation: "read" | "write",
  tokenOverride?: string,
): boolean {
  const token =
    tokenOverride ?? firstHeaderValue(headers["x-storage-access-token"]);
  const verification = verifyDispatchToken(token, config.accessSigningKey);
  const payload = verification.payload;

  if (
    !verification.valid ||
    payload?.purpose !== "storage-access" ||
    payload.storageId !== config.storageId ||
    payload.keyVersion !== config.accessSigningKeyVersion ||
    !payload.scope ||
    !payload.tokenId
  ) {
    return false;
  }

  if (operation === "read" && payload.scope === "write") {
    return false;
  }

  if (operation === "write" && payload.scope === "read") {
    return false;
  }

  if (payload.keyPrefix) {
    const keyPrefix = normalizeStorageKey(payload.keyPrefix);

    if (key !== keyPrefix && !key.startsWith(`${keyPrefix}/`)) {
      return false;
    }
  }

  return true;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
