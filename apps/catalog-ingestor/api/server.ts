import { createServer } from "node:http";
import type { Server } from "node:http";

import {
  requestUrl,
  writeCaughtError,
  writeError,
  writeJson,
} from "../../shared/http.js";
import { FixedWindowRateLimiter } from "../../shared/rateLimit.js";
import type { CatalogIngestorConfig } from "../config/index.js";

export function createCatalogIngestorServer(config: CatalogIngestorConfig): Server {
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
        writeJson(response, 200, {
          status: "ok",
          clientId: config.clientId,
          enabled: config.enabled,
          providers: config.providers,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/callbacks/jobs") {
        writeJson(response, 202, {
          accepted: true,
          ignored: true,
          reason: "catalog-ingestor does not process user job callbacks",
        });
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      writeCaughtError(response, error);
    }
  });
}