import { randomUUID } from "node:crypto";

import { sleep } from "../../shared/http.js";
import type {
  StorageObjectRef,
  TryOnJobCreateResponse,
  TryOnJobQueuedResponse,
  TryOnModelProvider,
  TryOnModelSelection,
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
  caption?: string;
  photo?: TelegramPhotoSize[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

interface BotCommand {
  command: string;
  description: string;
}

interface ParsedRequestCommand {
  model?: TryOnModelSelection;
  prompt?: string;
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
    const text = message?.text?.trim() ?? message?.caption?.trim();

    if (!message) {
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

    if (!text && message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Для анализа изображения отправьте фото с подписью /request openai.",
      );
      return;
    }

    const parsedRequest = text ? parseRequestCommand(text) : undefined;

    if (parsedRequest) {
      await this.createRequest(message, parsedRequest);
    }
  }

  private async createRequest(
    message: TelegramMessage,
    request: ParsedRequestCommand,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    if (request.model?.provider === "openai" && !message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Для OpenAI-анализа отправьте фото пользователя с подписью /request openai.",
      );
      return;
    }

    try {
      const inputFiles = await this.uploadMessagePhotos(message);
      const assignment = await this.coordinator.createRequestJob({
        chatId,
        username: message.from?.username,
        text: request.prompt,
        model: request.model,
        inputFiles,
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

  private async uploadMessagePhotos(
    message: TelegramMessage,
  ): Promise<StorageObjectRef[] | undefined> {
    if (!message.photo?.length) {
      return undefined;
    }

    const photo = [...message.photo].sort(compareTelegramPhotos).at(-1);

    if (!photo) {
      return undefined;
    }

    const file = await this.callApi<TelegramFile>("getFile", {
      file_id: photo.file_id,
    });

    if (!file.file_path) {
      throw new Error("Telegram did not return file_path for photo");
    }

    const requestId = randomUUID();
    const keyPrefix = `clients/${this.config.clientId}/input/${requestId}`;
    const storageAccess = await this.coordinator.requestStorageAccess({
      scope: "read-write",
      keyPrefix,
    });
    const sourceUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
    const downloadResponse = await fetchWithTimeout(
      sourceUrl,
      { method: "GET" },
      120_000,
    );

    if (!downloadResponse.ok || !downloadResponse.body) {
      throw new Error(
        `Telegram file download failed with ${downloadResponse.status}`,
      );
    }

    const filename = sanitizeStorageFilename(file.file_path);
    const key = `${keyPrefix}/${filename}`;
    const uploadResponse = await fetchWithTimeout(
      storageObjectUrl(storageAccess.storage.objectBaseUrl, key),
      {
        method: "PUT",
        headers: {
          "content-type":
            downloadResponse.headers.get("content-type") ??
            contentTypeFromFilename(filename),
          "x-storage-access-token": storageAccess.storage.accessToken,
        },
        body: downloadResponse.body,
        duplex: "half",
      } as RequestInit,
      120_000,
    );

    if (!uploadResponse.ok) {
      throw new Error(`Storage upload failed with ${uploadResponse.status}`);
    }

    const payload = (await uploadResponse.json()) as { object?: StorageObjectRef };

    if (!payload.object) {
      throw new Error("Storage upload response did not contain object metadata");
    }

    return [payload.object];
  }
}

function isQueuedJobResponse(
  response: TryOnJobCreateResponse,
): response is TryOnJobQueuedResponse {
  return "queued" in response;
}

function parseRequestCommand(text: string): ParsedRequestCommand | undefined {
  const parts = text.trim().split(/\s+/);
  const command = parts.shift()?.toLowerCase();

  if (command !== "/request" && command !== "request") {
    return undefined;
  }

  const model = parseModelSelection(parts[0]);

  if (model) {
    parts.shift();
  }

  return {
    model,
    prompt: parts.join(" ").trim() || undefined,
  };
}

function parseModelSelection(
  value: string | undefined,
): TryOnModelSelection | undefined {
  if (!value) {
    return undefined;
  }

  const [providerRaw, providerModelRaw] = value.split(":", 2);
  const provider = parseProvider(providerRaw.toLowerCase());
  const providerModel = providerModelRaw?.trim() || undefined;

  if (!provider) {
    return undefined;
  }

  return {
    provider,
    providerModel,
    task: provider === "openai" ? "wardrobe-recommendation" : "try-on",
    options:
      provider === "openai"
        ? {
            imageDetail: "high",
            textVerbosity: "high",
            reasoningEffort: "low",
            reasoningMode: "standard",
            store: false,
          }
        : undefined,
  };
}

function parseProvider(value: string): TryOnModelProvider | undefined {
  if (
    value === "mock" ||
    value === "pruna" ||
    value === "pixelcut" ||
    value === "tryoncloud" ||
    value === "genlook" ||
    value === "wearfits" ||
    value === "openai"
  ) {
    return value;
  }

  return undefined;
}

function compareTelegramPhotos(a: TelegramPhotoSize, b: TelegramPhotoSize): number {
  const aScore = a.file_size ?? a.width * a.height;
  const bScore = b.file_size ?? b.width * b.height;

  return aScore - bScore;
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

function encodeStorageKey(key: string): string {
  return key
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function storageObjectUrl(objectBaseUrl: string, key: string): string {
  return `${objectBaseUrl.replace(/\/$/, "")}/${encodeStorageKey(key)}`;
}

function sanitizeStorageFilename(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, "-") || "telegram-photo.jpg"
  );
}

function contentTypeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "png") {
    return "image/png";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  return "image/jpeg";
}
