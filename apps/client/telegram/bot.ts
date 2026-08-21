import { randomUUID } from "node:crypto";

import { sleep } from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
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

const logger = createLogger("telegram");
const telegramMessageChunkSize = 3_000;

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

type TelegramReplyMarkup = Record<string, unknown>;

interface ParsedRequestCommand {
  model?: TryOnModelSelection;
  prompt?: string;
}

interface ChatSession {
  mode: "awaiting-appearance-photo";
}

const appearanceAnalysisButtonText = "Разбор внешности";
const cancelButtonText = "Отмена";

const appearanceAnalysisPrompt = `
Ты выполняешь разбор внешности только по фотографии реального человека.

Сначала проверь изображение:
- это должна быть фотография реального человека, а не рисунок, рендер, аватар, мем, игрушка или скриншот;
- лицо человека должно быть видно достаточно ясно для аккуратного стилевого анализа;
- если лицо закрыто, слишком темно, размыто, человек снят со спины или на фото нет человека, анализ не выполняй.

Если изображение не подходит, ответь строго этой фразой:
"Вы загрузили не реальное фото или на фото не видно лица. Пожалуйста, отправьте четкую фотографию реального человека с видимым лицом."

Если изображение подходит, дай конкретный и полезный разбор внешности на русском языке. Ответ должен быть компактным: максимум 1300 символов, без длинного вступления и повторов.

Стиль ответа:
- пиши живо и естественно, как стилист, который быстро объясняет человеку сильные стороны образа;
- не используй длинное тире, символ U+2014 и похожие длинные тире. Вместо них ставь запятую, двоеточие, точку с запятой или обычный дефис "-";
- избегай канцелярита, шаблонных фраз и слишком общих советов.

Формат ответа:
**Вывод**
2-3 короткие живые фразы: что считывается во внешности, что стоит подчеркнуть в образе, какая подача будет смотреться естественно.

**Параметры**
- **Лицо:** форма лица, 1 короткое уточнение.
- **Контраст:** низкий/средний/высокий и что это значит для одежды.
- **Пропорции:** только видимые особенности, без оценочных суждений.
- **Цвета:** 4-6 подходящих оттенков.
- **Избегать:** 3-5 оттенков или сочетаний.
- **Фасоны:** футболки/рубашки/куртки/брюки одной короткой строкой.
- **Аксессуары:** 2-4 варианта.
- **Прическа:** 1-2 практичные рекомендации.
- **Стили:** 3 направления через запятую.

Не пытайся устанавливать личность человека. Не делай выводы о здоровье, этничности, религии, сексуальности, точном возрасте или других чувствительных признаках. Если освещение мешает точно определить цветотип, явно скажи об этом.
`.trim();

export class TelegramBot {
  private updateOffset = 0;
  private readonly sessions = new Map<string, ChatSession>();

  constructor(
    private readonly config: TelegramClientConfig,
    private readonly coordinator: TelegramCoordinatorClient,
    private readonly worker: TelegramWorkerClient,
  ) {}

  async startPolling(): Promise<void> {
    logger.info("Polling started", {
      clientId: this.config.clientId,
      pollingTimeoutSeconds: this.config.pollingTimeoutSeconds,
    });

    while (true) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          this.updateOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        logger.error("Polling error", {
          error,
        });
        await sleep(5_000);
      }
    }
  }

  sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<unknown> {
    return this.sendFormattedMessage(chatId, text, replyMarkup);
  }

  private async sendFormattedMessage(
    chatId: string,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<unknown> {
    const chunks = splitTelegramMessage(text);
    let result: unknown;

    if (chunks.length > 1) {
      logger.info("Telegram message split into chunks", {
        chatId,
        chunks: chunks.length,
        originalLength: text.length,
      });
    }

    for (const [index, chunk] of chunks.entries()) {
      const isLastChunk = index === chunks.length - 1;

      result = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: markdownToTelegramHtml(chunk),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }

    return result;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim() ?? message?.caption?.trim();

    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);

    if (text === "/start") {
      logger.info("Start command received", {
        chatId,
      });
      await this.setupCommands();
      this.sessions.delete(chatId);
      await this.sendStartMessage(chatId);
      return;
    }

    if (text && isCancelCommand(text)) {
      logger.info("Appearance analysis cancelled", {
        chatId,
      });
      this.sessions.delete(chatId);
      await this.sendMessage(
        chatId,
        "Разбор внешности отменен. Можем начать заново, когда будете готовы.",
        mainMenuMarkup(),
      );
      return;
    }

    if (text && isAppearanceAnalysisCommand(text)) {
      logger.info("Appearance analysis requested", {
        chatId,
      });
      await this.startAppearanceAnalysis(chatId);
      return;
    }

    const session = this.sessions.get(chatId);

    if (session?.mode === "awaiting-appearance-photo") {
      await this.handleAppearancePhotoStep(message);
      return;
    }

    if (!text && message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Чтобы сделать разбор внешности, сначала нажмите кнопку «Разбор внешности».",
        mainMenuMarkup(),
      );
      return;
    }

    const parsedRequest = text ? parseRequestCommand(text) : undefined;

    if (parsedRequest) {
      logger.info("Legacy request command received", {
        chatId,
        provider: parsedRequest.model?.provider ?? "mock",
        task: parsedRequest.model?.task,
        hasPhoto: Boolean(message.photo?.length),
      });
      await this.createRequest(message, parsedRequest);
    }
  }

  private sendStartMessage(chatId: string): Promise<unknown> {
    return this.sendMessage(
      chatId,
      "Хотите сделать разбор вашей внешности?",
      mainMenuMarkup(),
    );
  }

  private startAppearanceAnalysis(chatId: string): Promise<unknown> {
    this.sessions.set(chatId, {
      mode: "awaiting-appearance-photo",
    });
    logger.info("Appearance analysis awaiting photo", {
      chatId,
    });

    return this.sendMessage(
      chatId,
      "Отправьте изображение с вашим лицом.",
      cancelMarkup(),
    );
  }

  private async handleAppearancePhotoStep(
    message: TelegramMessage,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    if (!message.photo?.length) {
      logger.info("Appearance analysis expected photo but received non-photo", {
        chatId,
      });
      await this.sendMessage(
        chatId,
        "Пришлите фото реального человека с хорошо видимым лицом или нажмите «Отмена».",
        cancelMarkup(),
      );
      return;
    }

    await this.createAppearanceAnalysisRequest(message);
  }

  private async createAppearanceAnalysisRequest(
    message: TelegramMessage,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    try {
      logger.info("Appearance analysis photo received", {
        chatId,
        photoVariants: message.photo?.length ?? 0,
      });
      const inputFiles = await this.uploadMessagePhotos(message);

      if (!inputFiles?.length) {
        throw new Error(
          "No Telegram photos were uploaded for appearance analysis",
        );
      }

      logger.info("Appearance analysis storage upload completed", {
        chatId,
        files: inputFiles.map((file) => ({
          storageId: file.storageId,
          key: file.key,
          sizeBytes: file.sizeBytes,
          contentType: file.contentType,
        })),
      });

      logger.info("Appearance analysis job create requested", {
        chatId,
        provider: "openai",
        task: "appearance-analysis",
      });
      const assignment = await this.coordinator.createRequestJob({
        chatId,
        username: message.from?.username,
        text: appearanceAnalysisPrompt,
        model: createAppearanceAnalysisModelSelection(),
        inputFiles,
      });

      this.sessions.delete(chatId);

      if (isQueuedJobResponse(assignment)) {
        logger.info("Appearance analysis job queued", {
          chatId,
          jobId: assignment.job.id,
          reason: assignment.reason,
          retryAfterMs: assignment.retryAfterMs,
        });
        await this.sendMessage(
          chatId,
          `Фото принято. Запрос ${assignment.job.id} поставлен в очередь, подберу свободный сервер автоматически.`,
          mainMenuMarkup(),
        );
        void this.waitForAssignmentAndDispatch(
          chatId,
          assignment.job.id,
          assignment.retryAfterMs,
        );
        return;
      }

      logger.info("Appearance analysis job assigned", {
        chatId,
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
        workerBaseUrl: assignment.worker.baseUrl,
      });
      await this.worker.dispatchJob(assignment);
      logger.info("Appearance analysis job dispatched", {
        chatId,
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
      });

      await this.sendMessage(
        chatId,
        `Фото принято. Запрос ${assignment.job.id} отправлен на сервер. Ожидаю ответ.`,
        mainMenuMarkup(),
      );
    } catch (error) {
      logger.error("Failed to create appearance analysis job", {
        chatId,
        error,
      });
      await this.sendMessage(
        chatId,
        "Не удалось отправить фото на разбор. Попробуйте еще раз или нажмите «Отмена».",
        cancelMarkup(),
      );
    }
  }

  private async createRequest(
    message: TelegramMessage,
    request: ParsedRequestCommand,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    if (request.model?.provider === "openai" && !message.photo?.length) {
      logger.info("OpenAI request rejected before job creation because photo is missing", {
        chatId,
      });
      await this.sendMessage(
        chatId,
        "Для OpenAI-анализа отправьте фото пользователя с подписью /request openai.",
      );
      return;
    }

    try {
      logger.info("Job create requested", {
        chatId,
        provider: request.model?.provider ?? "mock",
        task: request.model?.task,
        hasPhoto: Boolean(message.photo?.length),
      });
      const inputFiles = await this.uploadMessagePhotos(message);
      const assignment = await this.coordinator.createRequestJob({
        chatId,
        username: message.from?.username,
        text: request.prompt,
        model: request.model,
        inputFiles,
      });

      if (isQueuedJobResponse(assignment)) {
        logger.info("Job queued", {
          chatId,
          jobId: assignment.job.id,
          reason: assignment.reason,
          retryAfterMs: assignment.retryAfterMs,
        });
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

      logger.info("Job assigned", {
        chatId,
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
        workerBaseUrl: assignment.worker.baseUrl,
      });
      await this.worker.dispatchJob(assignment);
      logger.info("Job dispatched", {
        chatId,
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
      });

      await this.sendMessage(
        chatId,
        `Запрос ${assignment.job.id} отправлен на сервер. Ожидаю ответ.`,
      );
    } catch (error) {
      logger.error("Failed to create or dispatch job", {
        chatId,
        provider: request.model?.provider ?? "mock",
        error,
      });
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
        logger.info("Polling queued job assignment", {
          chatId,
          jobId,
          attempt: attempt + 1,
        });
        const assignment = await this.coordinator.getJobAssignment(jobId);

        if (isQueuedJobResponse(assignment)) {
          logger.info("Job still queued", {
            chatId,
            jobId,
            reason: assignment.reason,
            retryAfterMs: assignment.retryAfterMs,
          });
          retryAfterMs = assignment.retryAfterMs;
          continue;
        }

        logger.info("Queued job assigned", {
          chatId,
          jobId: assignment.job.id,
          workerId: assignment.worker.workerId,
          workerBaseUrl: assignment.worker.baseUrl,
        });
        await this.worker.dispatchJob(assignment);
        logger.info("Queued job dispatched", {
          chatId,
          jobId: assignment.job.id,
          workerId: assignment.worker.workerId,
        });
        await this.sendMessage(
          chatId,
          `Запрос ${assignment.job.id} отправлен на сервер. Ожидаю ответ.`,
        );
        return;
      } catch (error) {
        logger.error("Failed to poll assignment", {
          chatId,
          jobId,
          attempt: attempt + 1,
          error,
        });
        retryAfterMs = Math.min(retryAfterMs * 2, 10_000);
      }
    }

    await this.sendMessage(
      chatId,
      `Запрос ${jobId} все еще в очереди. Попробуйте проверить позже.`,
    );
    logger.warn("Queued job polling exhausted", {
      chatId,
      jobId,
    });
  }

  private setupCommands(): Promise<unknown> {
    const commands: BotCommand[] = [
      {
        command: "start",
        description: "Запустить бота",
      },
      {
        command: "appearance",
        description: "Разбор внешности по фото",
      },
      {
        command: "request",
        description: "Создать запрос",
      },
      {
        command: "cancel",
        description: "Отменить текущий сценарий",
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
    logger.info("Requesting storage access for Telegram photo", {
      chatId: String(message.chat.id),
      keyPrefix,
      telegramFilePath: file.file_path,
      telegramFileSize: file.file_size,
    });
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
    const uploadContentType = resolveTelegramPhotoContentType(
      filename,
      downloadResponse.headers.get("content-type"),
    );
    logger.info("Uploading Telegram photo to storage", {
      chatId: String(message.chat.id),
      storageId: storageAccess.storage.storageId,
      key,
      objectBaseUrl: storageAccess.storage.objectBaseUrl,
      contentType: uploadContentType,
    });
    const uploadResponse = await fetchWithTimeout(
      storageObjectUrl(storageAccess.storage.objectBaseUrl, key),
      {
        method: "PUT",
        headers: {
          "content-type": uploadContentType,
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

    logger.info("Telegram photo uploaded to storage", {
      chatId: String(message.chat.id),
      storageId: payload.object.storageId,
      key: payload.object.key,
      sizeBytes: payload.object.sizeBytes,
      contentType: payload.object.contentType,
    });

    return [payload.object];
  }
}

function isQueuedJobResponse(
  response: TryOnJobCreateResponse,
): response is TryOnJobQueuedResponse {
  return "queued" in response;
}

function mainMenuMarkup(): TelegramReplyMarkup {
  return {
    keyboard: [[{ text: appearanceAnalysisButtonText }]],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function cancelMarkup(): TelegramReplyMarkup {
  return {
    keyboard: [[{ text: cancelButtonText }]],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function isAppearanceAnalysisCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);

  return (
    normalized === normalizeCommandText(appearanceAnalysisButtonText) ||
    normalized === "/appearance"
  );
}

function isCancelCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);

  return (
    normalized === normalizeCommandText(cancelButtonText) ||
    normalized === "/cancel" ||
    normalized === "cancel"
  );
}

function normalizeCommandText(text: string): string {
  return text.trim().toLowerCase();
}

function createAppearanceAnalysisModelSelection(): TryOnModelSelection {
  return {
    provider: "openai",
    task: "appearance-analysis",
    options: {
      imageDetail: "high",
      textVerbosity: "low",
      reasoningEffort: "low",
      reasoningMode: "standard",
      maxOutputTokens: 650,
      store: false,
    },
  };
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
            textVerbosity: "medium",
            reasoningEffort: "low",
            reasoningMode: "standard",
            maxOutputTokens: 900,
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

function resolveTelegramPhotoContentType(
  filename: string,
  responseContentType: string | null,
): string {
  if (responseContentType?.toLowerCase().startsWith("image/")) {
    return responseContentType;
  }

  return contentTypeFromFilename(filename);
}

function splitTelegramMessage(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();

  if (normalized.length <= telegramMessageChunkSize) {
    return [normalized || " "];
  }

  const chunks: string[] = [];
  let current = "";

  for (const block of normalized.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${block}` : block;

    if (candidate.length <= telegramMessageChunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    appendLongBlockChunks(chunks, block);
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length ? chunks : [" "];
}

function appendLongBlockChunks(chunks: string[], block: string): void {
  let current = "";

  for (const line of block.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length <= telegramMessageChunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    appendLongLineChunks(chunks, line);
  }

  if (current) {
    chunks.push(current);
  }
}

function appendLongLineChunks(chunks: string[], line: string): void {
  let current = "";

  for (const word of line.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= telegramMessageChunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    current = word;

    while (current.length > telegramMessageChunkSize) {
      chunks.push(current.slice(0, telegramMessageChunkSize));
      current = current.slice(telegramMessageChunkSize);
    }
  }

  if (current) {
    chunks.push(current);
  }
}

function markdownToTelegramHtml(markdown: string): string {
  let html = escapeHtml(markdown);

  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>',
  );

  return html;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
