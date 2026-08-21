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
import { createLogger } from "../../shared/logger.js";
import { FixedWindowRateLimiter } from "../../shared/rateLimit.js";
import { TokenReplayGuard } from "../../shared/tokenReplayGuard.js";
import type { TelegramBot } from "./bot.js";
import type { TelegramClientConfig } from "./config.js";

const logger = createLogger("telegram");

export function createTelegramCallbackServer(
  bot: TelegramBot,
  config: TelegramClientConfig,
): Server {
  const rateLimiter = new FixedWindowRateLimiter(
    config.apiRateLimitMaxRequests,
    config.apiRateLimitWindowMs,
  );
  const callbackReplayGuard = new TokenReplayGuard();
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
        logger.info("Callback request received", {
          remoteAddress: request.socket.remoteAddress,
        });
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isTelegramJobCallbackRequest(body)) {
          logger.warn("Invalid callback payload received", {
            remoteAddress: request.socket.remoteAddress,
          });
          writeError(
            response,
            400,
            "invalid_telegram_callback",
            "Invalid Telegram callback payload",
          );
          return;
        }

        const token = validateCallbackToken(request.headers, body.jobId, config);

        if (!token.valid) {
          logger.warn("Callback token rejected", {
            jobId: body.jobId,
            chatId: body.client.chatId,
            remoteAddress: request.socket.remoteAddress,
          });
          writeError(
            response,
            401,
            "unauthorized_callback",
            "Invalid callback token",
          );
          return;
        }

        if (callbackReplayGuard.hasSeen(token.tokenId)) {
          logger.warn("Callback token replay rejected", {
            jobId: body.jobId,
            chatId: body.client.chatId,
          });
          writeError(
            response,
            409,
            "callback_token_replayed",
            "Callback token has already been used",
          );
          return;
        }

        callbackReplayGuard.remember(token.tokenId, token.expiresAt);

        logger.info("Callback accepted, handing job result to bot", {
          jobId: body.jobId,
          chatId: body.client.chatId,
          messageLength: body.result.message.length,
          files: body.result.files?.length ?? 0,
        });
        await bot.handleJobCallback(body);
        logger.info("Callback handled by Telegram bot", {
          jobId: body.jobId,
          chatId: body.client.chatId,
        });

        writeJson(response, 200, {
          ok: true,
          jobId: body.jobId,
        });
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      logger.error("Callback server error", {
        error,
      });
      writeCaughtError(response, error);
    }
  });
}

function validateCallbackToken(
  headers: Record<string, string | string[] | undefined>,
  jobId: string,
  config: TelegramClientConfig,
): { valid: true; tokenId: string; expiresAt: string } | { valid: false } {
  const token = firstHeaderValue(headers["x-client-callback-token"]);
  const verification = verifyDispatchToken(token, config.callbackSigningKey);
  const payload = verification.payload;

  if (
    verification.valid &&
    payload?.purpose === "client-callback" &&
    payload.jobId === jobId &&
    payload.clientId === config.clientId &&
    payload.keyVersion === config.callbackSigningKeyVersion &&
    payload.tokenId
  ) {
    return {
      valid: true,
      tokenId: payload.tokenId,
      expiresAt: payload.expiresAt,
    };
  }

  return {
    valid: false,
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
