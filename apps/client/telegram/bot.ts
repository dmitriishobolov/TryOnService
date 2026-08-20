import { sleep } from "../../shared/http.js";
import type {
  TryOnJobCreateResponse,
  TryOnJobQueuedResponse,
} from "../../shared/contracts/index.js";
import type { TelegramClientConfig } from "./config.js";
import type { TelegramCoordinatorClient } from "./coordinatorClient.js";
import type { TelegramWorkerClient } from "./workerClient.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUser {
  username?: string;
}

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface BotCommand {
  command: string;
  description: string;
}

export class TelegramBot {
  private updateOffset = 0;

  constructor(
    private readonly config: TelegramClientConfig,
    private readonly coordinator: TelegramCoordinatorClient,
    private readonly worker: TelegramWorkerClient,
  ) {}

  async startPolling(): Promise<void> {
    console.log("[telegram] Polling started");

    while (true) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          this.updateOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        console.error("[telegram] Polling error", error);
        await sleep(5_000);
      }
    }
  }

  sendMessage(chatId: string, text: string): Promise<unknown> {
    return this.callApi("sendMessage", {
      chat_id: chatId,
      text,
    });
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim();

    if (!message || !text) {
      return;
    }

    const chatId = String(message.chat.id);

    if (text === "/start") {
      await this.setupCommands();
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: "Сервис готов. Нажмите Request, чтобы создать запрос.",
        reply_markup: {
          keyboard: [[{ text: "Request" }]],
          resize_keyboard: true,
          one_time_keyboard: false,
        },
      });
      return;
    }

    if (text === "/request" || text.toLowerCase() === "request") {
      await this.createRequest(message);
    }
  }

  private async createRequest(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);

    try {
      const assignment = await this.coordinator.createRequestJob({
        chatId,
        username: message.from?.username,
        text: message.text,
      });

      if (isQueuedJobResponse(assignment)) {
        await this.sendMessage(
          chatId,
          `Запрос ${assignment.job.id} поставлен в очередь. Подберу свободный сервер автоматически.`,
        );
        void this.waitForAssignmentAndDispatch(
          chatId,
          assignment.job.id,
          assignment.retryAfterMs,
        );
        return;
      }

      await this.worker.dispatchJob(assignment);

      await this.sendMessage(
        chatId,
        `Запрос ${assignment.job.id} отправлен на сервер. Ожидаю ответ.`,
      );
    } catch (error) {
      console.error("[telegram] Failed to create or dispatch job", error);
      await this.sendMessage(
        chatId,
        "Не удалось создать запрос. Попробуйте еще раз позже.",
      );
    }
  }

  private async waitForAssignmentAndDispatch(
    chatId: string,
    jobId: string,
    initialRetryAfterMs: number,
  ): Promise<void> {
    let retryAfterMs = initialRetryAfterMs;

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(retryAfterMs);

      try {
        const assignment = await this.coordinator.getJobAssignment(jobId);

        if (isQueuedJobResponse(assignment)) {
          retryAfterMs = assignment.retryAfterMs;
          continue;
        }

        await this.worker.dispatchJob(assignment);
        await this.sendMessage(
          chatId,
          `Запрос ${assignment.job.id} отправлен на сервер. Ожидаю ответ.`,
        );
        return;
      } catch (error) {
        console.error(`[telegram] Failed to poll assignment for job ${jobId}`, error);
        retryAfterMs = Math.min(retryAfterMs * 2, 10_000);
      }
    }

    await this.sendMessage(
      chatId,
      `Запрос ${jobId} все еще в очереди. Попробуйте проверить позже.`,
    );
  }

  private setupCommands(): Promise<unknown> {
    const commands: BotCommand[] = [
      {
        command: "start",
        description: "Запустить бота",
      },
      {
        command: "request",
        description: "Создать запрос",
      },
    ];

    return this.callApi("setMyCommands", {
      commands,
    });
  }

  private getUpdates(): Promise<TelegramUpdate[]> {
    return this.callApi<TelegramUpdate[]>("getUpdates", {
      offset: this.updateOffset,
      timeout: this.config.pollingTimeoutSeconds,
      allowed_updates: ["message"],
    });
  }

  private async callApi<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    const data = (await response.json()) as TelegramApiResponse<T>;

    if (!response.ok || !data.ok) {
      throw new Error(data.description ?? `Telegram API ${method} failed`);
    }

    return data.result as T;
  }
}

function isQueuedJobResponse(
  response: TryOnJobCreateResponse,
): response is TryOnJobQueuedResponse {
  return "queued" in response;
}
