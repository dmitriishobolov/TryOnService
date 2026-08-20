import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";

import { verifyDispatchToken } from "../../shared/dispatchToken.js";
import {
  HttpRequestError,
  requestUrl,
  writeCaughtError,
  writeError,
  writeJson,
} from "../../shared/http.js";
import { FixedWindowRateLimiter } from "../../shared/rateLimit.js";
import {
  normalizeStorageKey,
  type ObjectStorage,
} from "../../shared/storage/index.js";
import type { StorageConfig } from "../config/index.js";

interface StorageServerDeps {
  config: StorageConfig;
  objects: ObjectStorage;
  getUsedBytes: () => Promise<number | undefined>;
}

export function createStorageServer(deps: StorageServerDeps): Server {
  const { config, objects, getUsedBytes } = deps;
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

      const objectMatch = /^\/objects\/(.+)$/.exec(url.pathname);

      if (objectMatch && request.method === "PUT") {
        const key = normalizeStorageKey(decodeURIComponent(objectMatch[1]));

        if (!hasStorageObjectAccess(request.headers, config, key, "write")) {
          writeError(
            response,
            401,
            "unauthorized_storage_object",
            "Invalid storage access token",
          );
          return;
        }

        const data = await readRawBody(request, config.maxObjectBytes);
        const object = await objects.putObject({
          key,
          contentType: firstHeaderValue(request.headers["content-type"]),
          data,
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

        if (!hasStorageObjectAccess(request.headers, config, key, "read")) {
          writeError(
            response,
            401,
            "unauthorized_storage_object",
            "Invalid storage access token",
          );
          return;
        }

        const object = await objects.getObject(key);

        response.writeHead(200, {
          "Content-Type": object.ref.contentType ?? "application/octet-stream",
          "Content-Length": object.data.length,
        });
        response.end(object.data);
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      console.error("[storage] Unhandled request error", error);
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
): boolean {
  const token = firstHeaderValue(headers["x-storage-access-token"]);
  const verification = verifyDispatchToken(token, config.accessSigningKey);
  const payload = verification.payload;

  if (
    !verification.valid ||
    payload?.purpose !== "storage-access" ||
    payload.storageId !== config.storageId ||
    !payload.scope
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

async function readRawBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maxBytes) {
      throw new HttpRequestError(
        413,
        "object_too_large",
        `Storage object exceeds ${maxBytes} bytes`,
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
