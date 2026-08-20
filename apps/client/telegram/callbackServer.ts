import { createServer } from "node:http";
import type { Server } from "node:http";

import { isTelegramJobCallbackRequest } from "../../shared/contracts/index.js";
import { verifyDispatchToken } from "../../shared/dispatchToken.js";
import {
  writeCaughtError,
  readJsonBody,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import { FixedWindowRateLimiter } from "../../shared/rateLimit.js";
import type { TelegramBot } from "./bot.js";
import type { TelegramClientConfig } from "./config.js";

export function createTelegramCallbackServer(
  bot: TelegramBot,
  config: TelegramClientConfig,
): Server {
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
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/callbacks/jobs") {
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isTelegramJobCallbackRequest(body)) {
          writeError(
            response,
            400,
            "invalid_telegram_callback",
            "Invalid Telegram callback payload",
          );
          return;
        }

        if (!hasValidCallbackToken(request.headers, body.jobId, config)) {
          writeError(
            response,
            401,
            "unauthorized_callback",
            "Invalid callback token",
          );
          return;
        }

        await bot.sendMessage(body.client.chatId, body.result.message);

        writeJson(response, 200, {
          ok: true,
          jobId: body.jobId,
        });
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      console.error("[telegram] Callback server error", error);
      writeCaughtError(response, error);
    }
  });
}

function hasValidCallbackToken(
  headers: Record<string, string | string[] | undefined>,
  jobId: string,
  config: TelegramClientConfig,
): boolean {
  const token = firstHeaderValue(headers["x-client-callback-token"]);
  const verification = verifyDispatchToken(token, config.callbackSigningKey);

  return (
    verification.valid &&
    verification.payload?.purpose === "client-callback" &&
    verification.payload.jobId === jobId &&
    verification.payload.clientId === config.clientId
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
