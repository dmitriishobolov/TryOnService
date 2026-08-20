import { createServer } from "node:http";
import type { Server } from "node:http";

import { isTelegramJobCallbackRequest } from "../../shared/contracts/index.js";
import {
  readJsonBody,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import type { TelegramBot } from "./bot.js";

export function createTelegramCallbackServer(bot: TelegramBot): Server {
  return createServer(async (request, response) => {
    const url = requestUrl(request);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/callbacks/jobs") {
        const body = await readJsonBody(request);

        if (!isTelegramJobCallbackRequest(body)) {
          writeError(
            response,
            400,
            "invalid_telegram_callback",
            "Invalid Telegram callback payload",
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
      writeError(response, 500, "internal_error", "Internal server error");
    }
  });
}
