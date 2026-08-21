import { Blob } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import { sleep } from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
import type {
  StorageObjectRef,
  StorageAccessAssignment,
  StorageCatalogEntryUpsertRequest,
  MarketProductRef,
  MarketProvider,
  MarketSearchSelection,
  TelegramJobCallbackRequest,
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
const telegramCaptionLimit = 1_024;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramPhotoUpload {
  blob: Blob;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface IdealProgressMessage {
  messageId: number;
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

type ChatSession =
  | {
      mode: "awaiting-appearance-photo";
    }
  | {
      mode: "awaiting-ideal-full-body-photo";
    }
  | {
      mode: "awaiting-ideal-outfit-choice";
      outfits: IdealOutfit[];
      inputFiles: StorageObjectRef[];
      username?: string;
    };

interface IdealMarketSearchState {
  chatId: string;
  outfit: IdealOutfit;
  inputFiles: StorageObjectRef[];
  totalJobs: number;
  completedJobs: number;
  candidates: IdealProduct[];
  missingItems: IdealMissingItem[];
}

type PendingJob =
  | {
      flow: "appearance";
      chatId: string;
    }
  | {
      flow: "legacy";
      chatId: string;
    }
  | {
      flow: "ideal-plan";
      chatId: string;
      inputFiles: StorageObjectRef[];
      username?: string;
    }
  | {
      flow: "ideal-products";
      chatId: string;
      outfit: IdealOutfit;
      inputFiles: StorageObjectRef[];
      item: IdealOutfitItem;
      marketProvider: MarketProvider;
      searchState: IdealMarketSearchState;
    }
  | {
      flow: "ideal-products-validation";
      chatId: string;
      outfit: IdealOutfit;
      inputFiles: StorageObjectRef[];
      candidates: IdealProduct[];
      missingItems: IdealMissingItem[];
    }
  | {
      flow: "ideal-product-card-generation";
      chatId: string;
      outfit: IdealOutfit;
      product: IdealProduct;
      remainingProducts: IdealProduct[];
      generatedProducts: IdealProduct[];
      missingItems: IdealMissingItem[];
      inputFiles: StorageObjectRef[];
    };

interface IdealOutfitItem {
  slot: string;
  category: string;
  color?: string;
  description: string;
  searchQuery: string;
}

interface IdealOutfit {
  id: string;
  title: string;
  summary: string;
  items: IdealOutfitItem[];
}

interface IdealPlanResponse {
  ok: boolean;
  errorMessage?: string;
  footwearVisible?: boolean;
  summary?: string;
  outfits?: IdealOutfit[];
}

interface IdealProduct {
  slot: string;
  category: string;
  title: string;
  shortDescription: string;
  productUrl: string;
  imageUrl: string;
  price?: string;
  source?: string;
  whyFits?: string;
  originalImageUrl?: string;
}

interface IdealProductCardCacheRef {
  keyPrefix: string;
  imageKey: string;
  metadataKey: string;
  canonicalProductUrl: string;
  catalogCacheKey: string;
}

interface IdealMissingItem {
  slot: string;
  category: string;
  reason: string;
}

interface IdealProductValidationResponse {
  ok: boolean;
  errorMessage?: string;
  lookTitle?: string;
  acceptedCandidates?: IdealAcceptedCandidate[];
  missingItems?: IdealMissingItem[];
}

interface IdealAcceptedCandidate {
  imageIndex: number;
  whyFits?: string;
  canGenerateCleanCard: boolean;
  reason?: string;
}

interface IdealOutfitSanitizeOptions {
  allowFootwear: boolean;
}

const appearanceAnalysisButtonText = "Анализ внешности";
const legacyAppearanceAnalysisButtonText = "Разбор внешности";
const idealOutfitButtonText = "Идеальный образ";
const cancelButtonText = "Отмена";
const idealCandidatesPerOutfitItem = 10;
const idealMarketProviders = ["ozon", "wildberries"] as const;
const idealCandidatesPerMarketProvider = Math.ceil(
  idealCandidatesPerOutfitItem / idealMarketProviders.length,
);

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

const idealOutfitPlanPrompt = `
Ты fashion stylist для сервиса виртуальной примерки.

Сначала проверь изображение:
- это должна быть фотография реального человека;
- человек должен быть виден примерно в полный рост: голова, корпус и большая часть ног;
- стопы или обувь могут быть не видны из-за кадрирования, такое фото всё равно подходит;
- поза, освещение и одежда должны позволять оценить пропорции фигуры и общий силуэт;
- если это селфи только лица, портрет по пояс, рисунок, рендер, аватар, мем, скриншот, фото со спины или человек плохо виден, образ не подбирай.

Если фото не подходит, верни строгий JSON:
{
  "ok": false,
  "errorMessage": "Для подбора идеального образа нужно фото почти в полный рост: должны быть хорошо видны голова, корпус и большая часть ног. Обувь может не попадать в кадр. Пришлите, пожалуйста, подходящее фото."
}

Если фото подходит, подбери максимум 3 разных комбинации одежды. Они должны подходить человеку по видимым пропорциям, контрасту, цветам и общей подаче. Не делай выводы о личности, здоровье, этничности, религии, сексуальности или точном возрасте.

Правила комбинаций:
- в одном образе не должно быть дублей одной категории: не добавляй два худи, две куртки, две рубашки, две пары брюк и так далее;
- если стопы или обувь не видны, установи "footwearVisible": false и не добавляй обувь, ботинки, кроссовки, туфли, лоферы или другую footwear-категорию в items;
- если стопы и обувь видны достаточно ясно, установи "footwearVisible": true, обувь можно добавить только если она действительно важна для образа;
- образ должен быть собираемым из понятных товарных категорий;
- каждый item должен иметь отдельный slot, category, description и searchQuery;
- searchQuery должен быть хорошим запросом для поиска товара в интернет-магазинах на русском языке;
- не используй длинное тире, символ U+2014.

Верни только строгий JSON без Markdown:
{
  "ok": true,
  "footwearVisible": true,
  "summary": "1-2 короткие фразы о подходящем направлении образов",
  "outfits": [
    {
      "id": "look_1",
      "title": "Название образа",
      "summary": "Коротко почему образ подходит",
      "items": [
        {
          "slot": "top",
          "category": "рубашка",
          "color": "молочный",
          "description": "молочная рубашка свободного кроя из плотного хлопка",
          "searchQuery": "молочная рубашка oversize плотный хлопок"
        }
      ]
    }
  ]
}
`.trim();

export class TelegramBot {
  private updateOffset = 0;
  private readonly sessions = new Map<string, ChatSession>();
  private readonly pendingJobs = new Map<string, PendingJob>();
  private readonly idealProgressMessages = new Map<string, IdealProgressMessage>();

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

  private async updateIdealProgressMessage(
    chatId: string,
    text: string,
  ): Promise<void> {
    const existing = this.idealProgressMessages.get(chatId);

    if (existing) {
      try {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: existing.messageId,
          text: markdownToTelegramHtml(text),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        return;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        if (message.includes("message is not modified")) {
          return;
        }

        logger.warn("Failed to edit ideal progress message, sending a new one", {
          chatId,
          messageId: existing.messageId,
          error,
        });
        this.idealProgressMessages.delete(chatId);
      }
    }

    const sent = await this.sendFormattedMessage(chatId, text);
    const messageId = readTelegramMessageId(sent);

    if (messageId) {
      this.idealProgressMessages.set(chatId, {
        messageId,
      });
      logger.info("Ideal progress message created", {
        chatId,
        messageId,
      });
    } else {
      logger.warn("Ideal progress message id was not returned by Telegram", {
        chatId,
      });
    }
  }

  private clearIdealProgressMessage(chatId: string): void {
    this.idealProgressMessages.delete(chatId);
  }

  async handleJobCallback(callback: TelegramJobCallbackRequest): Promise<void> {
    const pending = this.pendingJobs.get(callback.jobId);

    if (!pending) {
      logger.info("Callback has no pending Telegram flow, sending raw result", {
        jobId: callback.jobId,
        chatId: callback.client.chatId,
      });
      await this.sendMessage(callback.client.chatId, callback.result.message);
      return;
    }

    this.pendingJobs.delete(callback.jobId);

    if (pending.flow === "appearance") {
      await this.sendMessage(pending.chatId, callback.result.message, mainMenuMarkup());
      return;
    }

    if (pending.flow === "legacy") {
      await this.sendMessage(pending.chatId, callback.result.message, mainMenuMarkup());
      return;
    }

    if (pending.flow === "ideal-plan") {
      await this.handleIdealPlanCallback(pending, callback.result.message);
      return;
    }

    if (pending.flow === "ideal-products") {
      await this.handleIdealProductsCallback(pending, callback);
      return;
    }

    if (pending.flow === "ideal-products-validation") {
      await this.handleIdealProductValidationCallback(pending, callback);
      return;
    }

    await this.handleIdealProductCardGenerationCallback(pending, callback);
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

  private async sendPhoto(
    chatId: string,
    photoUrl: string,
    caption: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<unknown> {
    const upload = await this.downloadPhotoForTelegramUpload(photoUrl);
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", upload.blob, upload.filename);
    form.append(
      "caption",
      markdownToTelegramHtml(truncateText(caption, telegramCaptionLimit)),
    );
    form.append("parse_mode", "HTML");

    if (replyMarkup) {
      form.append("reply_markup", JSON.stringify(replyMarkup));
    }

    logger.info("Uploading product photo to Telegram", {
      chatId,
      filename: upload.filename,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      sourceUrl: redactUrlQuery(photoUrl),
    });

    return this.callMultipartApi("sendPhoto", form);
  }

  private async downloadPhotoForTelegramUpload(
    photoUrl: string,
  ): Promise<TelegramPhotoUpload> {
    const response = await fetchWithTimeout(
      photoUrl,
      {
        method: "GET",
        headers: {
          Accept: "image/*,*/*;q=0.8",
        },
      },
      this.config.httpClientTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Photo download failed with ${response.status}`);
    }

    const contentType = resolveTelegramPhotoContentType(
      telegramPhotoFilenameFromUrl(photoUrl),
      response.headers.get("content-type"),
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = ensureFilenameExtension(
      telegramPhotoFilenameFromUrl(photoUrl),
      contentType,
    );

    return {
      blob: new Blob([new Uint8Array(buffer)], {
        type: contentType,
      }),
      filename,
      contentType,
      sizeBytes: buffer.length,
    };
  }

  private async getCachedIdealProductCard(
    chatId: string,
    product: IdealProduct,
  ): Promise<IdealProduct | undefined> {
    const cache = createIdealProductCardCacheRef(
      this.config.clientId,
      product.productUrl,
    );
    const catalogProduct = await this.getCatalogCachedIdealProductCard(
      chatId,
      product,
      cache,
    );

    if (catalogProduct) {
      return catalogProduct;
    }

    try {
      const storage = await this.requestProductCardCacheAccess(cache, "read");
      const response = await fetchWithTimeout(
        storageObjectUrl(storage.objectBaseUrl, cache.imageKey),
        {
          method: "GET",
          headers: {
            "x-storage-access-token": storage.accessToken,
          },
        },
        this.config.httpClientTimeoutMs,
      );

      if (response.status === 404) {
        await response.body?.cancel();
        logger.info("Ideal outfit clean product card cache miss", {
          chatId,
          key: cache.imageKey,
          productUrl: product.productUrl,
        });
        return undefined;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Product card cache lookup failed with ${response.status}`);
      }

      await response.body?.cancel();

      return {
        ...product,
        originalImageUrl: product.originalImageUrl ?? product.imageUrl,
        imageUrl: storageObjectAccessUrl(
          storage.objectBaseUrl,
          cache.imageKey,
          storage.accessToken,
        ),
      };
    } catch (error) {
      logger.warn("Ideal outfit clean product card cache lookup failed", {
        chatId,
        category: product.category,
        title: product.title,
        productUrl: product.productUrl,
        error,
      });
      return undefined;
    }
  }

  private async getCatalogCachedIdealProductCard(
    chatId: string,
    product: IdealProduct,
    cache: IdealProductCardCacheRef,
  ): Promise<IdealProduct | undefined> {
    try {
      const lookup = await this.coordinator.lookupStorageCatalog({
        cacheKeys: [cache.catalogCacheKey],
        kinds: ["product-card-image"],
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
              Accept: "image/*,*/*;q=0.8",
            },
          },
          this.config.httpClientTimeoutMs,
        );

        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }

        await response.body?.cancel();
        logger.info("Ideal outfit clean product card catalog cache hit", {
          chatId,
          storageId: location.storageId,
          key: location.entry.object.key,
          productUrl: product.productUrl,
        });

        return {
          ...product,
          originalImageUrl: product.originalImageUrl ?? product.imageUrl,
          imageUrl: location.objectUrl,
        };
      }
    } catch (error) {
      logger.warn("Ideal outfit clean product card catalog lookup failed", {
        chatId,
        productUrl: product.productUrl,
        cacheKey: cache.catalogCacheKey,
        error,
      });
    }

    return undefined;
  }

  private async cacheIdealProductCard(
    chatId: string,
    product: IdealProduct,
    generatedFile: StorageObjectRef,
  ): Promise<StorageObjectRef | undefined> {
    if (!generatedFile.url) {
      return undefined;
    }

    const cache = createIdealProductCardCacheRef(
      this.config.clientId,
      product.productUrl,
    );

    try {
      const storage = await this.requestProductCardCacheAccess(
        cache,
        "read-write",
      );
      const sourceResponse = await fetchWithTimeout(
        generatedFile.url,
        {
          method: "GET",
          headers: {
            Accept: "image/*,*/*;q=0.8",
          },
        },
        this.config.httpClientTimeoutMs,
      );

      if (!sourceResponse.ok || !sourceResponse.body) {
        await sourceResponse.body?.cancel();
        throw new Error(
          `Generated product card download failed with ${sourceResponse.status}`,
        );
      }

      const contentType =
        sourceResponse.headers.get("content-type") ??
        generatedFile.contentType ??
        "image/png";
      const uploadResponse = await fetchWithTimeout(
        storageObjectUrl(storage.objectBaseUrl, cache.imageKey),
        {
          method: "PUT",
          headers: {
            "content-type": contentType,
            "x-storage-access-token": storage.accessToken,
          },
          body: sourceResponse.body,
          duplex: "half",
        } as RequestInit,
        this.config.httpClientTimeoutMs,
      );

      if (!uploadResponse.ok) {
        throw new Error(
          `Product card cache upload failed with ${uploadResponse.status}`,
        );
      }

      const payload = (await uploadResponse.json()) as {
        object?: StorageObjectRef;
      };

      if (!payload.object) {
        throw new Error("Product card cache upload did not return metadata");
      }

      try {
        await this.putIdealProductCardCacheMetadata(storage, cache, product, {
          imageKey: payload.object.key,
          sourceGeneratedKey: generatedFile.key,
          contentType: payload.object.contentType ?? contentType,
          sizeBytes: payload.object.sizeBytes,
        });
      } catch (metadataError) {
        logger.warn("Ideal outfit clean product card cache metadata failed", {
          chatId,
          key: payload.object.key,
          metadataKey: cache.metadataKey,
          productUrl: product.productUrl,
          error: metadataError,
        });
      }

      try {
        await this.putStorageCatalogEntry(storage, {
          entry: {
            cacheKey: cache.catalogCacheKey,
            kind: "product-card-image",
            objectKey: payload.object.key,
            metadata: {
              productUrl: product.productUrl,
              canonicalProductUrl: cache.canonicalProductUrl,
              title: product.title,
              category: product.category,
              slot: product.slot,
              source: product.source,
            },
          },
        });
        await this.putStorageCatalogEntry(storage, {
          entry: {
            cacheKey: cache.catalogCacheKey,
            kind: "product-card-metadata",
            objectKey: cache.metadataKey,
            metadata: {
              productUrl: product.productUrl,
              canonicalProductUrl: cache.canonicalProductUrl,
              title: product.title,
              category: product.category,
            },
          },
        });
      } catch (catalogError) {
        logger.warn("Ideal outfit clean product card catalog entry failed", {
          chatId,
          key: payload.object.key,
          metadataKey: cache.metadataKey,
          productUrl: product.productUrl,
          error: catalogError,
        });
      }

      logger.info("Ideal outfit clean product card cached", {
        chatId,
        key: payload.object.key,
        metadataKey: cache.metadataKey,
        category: product.category,
        title: product.title,
        productUrl: product.productUrl,
      });

      return {
        ...payload.object,
        url: storageObjectAccessUrl(
          storage.objectBaseUrl,
          payload.object.key,
          storage.accessToken,
        ),
      };
    } catch (error) {
      logger.warn("Ideal outfit clean product card cache write failed", {
        chatId,
        category: product.category,
        title: product.title,
        productUrl: product.productUrl,
        generatedKey: generatedFile.key,
        error,
      });
      return undefined;
    }
  }

  private async putIdealProductCardCacheMetadata(
    storage: StorageAccessAssignment,
    cache: IdealProductCardCacheRef,
    product: IdealProduct,
    cached: {
      imageKey: string;
      sourceGeneratedKey: string;
      contentType?: string;
      sizeBytes?: number;
    },
  ): Promise<void> {
    const response = await fetchWithTimeout(
      storageObjectUrl(storage.objectBaseUrl, cache.metadataKey),
      {
        method: "PUT",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-storage-access-token": storage.accessToken,
        },
        body: JSON.stringify({
          version: 1,
          cachedAt: new Date().toISOString(),
          productUrl: product.productUrl,
          canonicalProductUrl: cache.canonicalProductUrl,
          title: product.title,
          category: product.category,
          slot: product.slot,
          source: product.source,
          price: product.price,
          sourceImageUrl: product.originalImageUrl ?? product.imageUrl,
          imageKey: cached.imageKey,
          sourceGeneratedKey: cached.sourceGeneratedKey,
          contentType: cached.contentType,
          sizeBytes: cached.sizeBytes,
        }),
      },
      this.config.httpClientTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(
        `Product card cache metadata upload failed with ${response.status}`,
      );
    }
  }

  private async putStorageCatalogEntry(
    storage: StorageAccessAssignment,
    request: StorageCatalogEntryUpsertRequest,
  ): Promise<void> {
    const response = await fetchWithTimeout(
      `${storage.baseUrl.replace(/\/$/, "")}/catalog/entries`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-storage-access-token": storage.accessToken,
        },
        body: JSON.stringify(request),
      },
      this.config.httpClientTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Storage catalog entry upload failed with ${response.status}`);
    }

    await response.body?.cancel();
  }

  private async requestProductCardCacheAccess(
    cache: IdealProductCardCacheRef,
    scope: "read" | "read-write",
  ): Promise<StorageAccessAssignment> {
    const { storage } = await this.coordinator.requestStorageAccess({
      scope,
      keyPrefix: cache.keyPrefix,
    });

    return storage;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim() ?? message?.caption?.trim();

    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);
    const pendingJob = this.findPendingJobForChat(chatId);

    if (pendingJob) {
      logger.info("Telegram update blocked while job is in progress", {
        chatId,
        flow: pendingJob.flow,
        text,
        hasPhoto: Boolean(message.photo?.length),
      });
      await this.sendProcessBusyMessage(chatId, pendingJob);
      return;
    }

    const session = this.sessions.get(chatId);

    if (session) {
      if (text && isCancelCommand(text)) {
        logger.info("Telegram flow cancelled", {
          chatId,
        });
        this.sessions.delete(chatId);
        await this.sendMessage(
          chatId,
          "Ок, остановились. Выберите, что сделать дальше.",
          mainMenuMarkup(),
        );
        return;
      }

      if (text && isInterruptingCommand(text)) {
        logger.info("Telegram command blocked while session is active", {
          chatId,
          mode: session.mode,
          text,
        });
        await this.sendActiveSessionMessage(chatId, session);
        return;
      }

      if (session.mode === "awaiting-appearance-photo") {
        await this.handleAppearancePhotoStep(message);
        return;
      }

      if (session.mode === "awaiting-ideal-full-body-photo") {
        await this.handleIdealFullBodyPhotoStep(message);
        return;
      }

      await this.handleIdealOutfitChoiceStep(message, session);
      return;
    }

    if (text === "/start") {
      logger.info("Start command received", {
        chatId,
      });
      await this.setupCommands();
      await this.sendStartMessage(chatId);
      return;
    }

    if (text && isCancelCommand(text)) {
      logger.info("Telegram flow cancelled", {
        chatId,
      });
      await this.sendMessage(
        chatId,
        "Ок, остановились. Выберите, что сделать дальше.",
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

    if (text && isIdealOutfitCommand(text)) {
      logger.info("Ideal outfit requested", {
        chatId,
      });
      await this.startIdealOutfit(chatId);
      return;
    }

    if (!text && message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Выберите сначала сценарий: анализ внешности или идеальный образ.",
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
      [
        "Привет! Я помогу подобрать одежду под внешность и собрать товарную подборку для будущей виртуальной примерки.",
        "",
        "**Анализ внешности**: пришлите фото с лицом, я дам компактный стилистический разбор.",
        "**Идеальный образ**: пришлите фото почти в полный рост, я предложу до 3 образов, а после выбора найду похожие товары с подходящими фото. Если обувь не видна, искать обувь не буду.",
      ].join("\n"),
      mainMenuMarkup(),
    );
  }

  private findPendingJobForChat(chatId: string): PendingJob | undefined {
    for (const pending of this.pendingJobs.values()) {
      if (pending.chatId === chatId) {
        return pending;
      }
    }

    return undefined;
  }

  private sendProcessBusyMessage(
    chatId: string,
    pending: PendingJob,
  ): Promise<unknown> {
    return this.sendMessage(
      chatId,
      `Сейчас уже выполняю процесс: **${describePendingJob(pending)}**. Дождитесь результата, чтобы не сбить шаги бота.`,
      processingMarkup(),
    );
  }

  private sendActiveSessionMessage(
    chatId: string,
    session: ChatSession,
  ): Promise<unknown> {
    if (session.mode === "awaiting-appearance-photo") {
      return this.sendMessage(
        chatId,
        "Сейчас открыт анализ внешности. Пришлите фото с лицом или нажмите «Отмена».",
        cancelMarkup(),
      );
    }

    if (session.mode === "awaiting-ideal-full-body-photo") {
      return this.sendMessage(
        chatId,
        "Сейчас открыт подбор идеального образа. Пришлите фото почти в полный рост или нажмите «Отмена».",
        cancelMarkup(),
      );
    }

    return this.sendMessage(
      chatId,
      "Сначала выберите один из предложенных образов или нажмите «Отмена».",
      idealOutfitChoiceMarkup(session.outfits),
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

  private startIdealOutfit(chatId: string): Promise<unknown> {
    this.sessions.set(chatId, {
      mode: "awaiting-ideal-full-body-photo",
    });
    logger.info("Ideal outfit awaiting full-body photo", {
      chatId,
    });

    return this.sendMessage(
      chatId,
      "Отправьте фото почти в полный рост: должны быть хорошо видны голова, корпус и большая часть ног. Если обувь не попала в кадр, это нормально.",
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

  private async handleIdealFullBodyPhotoStep(
    message: TelegramMessage,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    if (!message.photo?.length) {
      logger.info("Ideal outfit expected photo but received non-photo", {
        chatId,
      });
      await this.sendMessage(
        chatId,
        "Нужно фото почти в полный рост: голова, корпус и большая часть ног. Обувь может не попадать в кадр. Пришлите подходящее изображение или нажмите «Отмена».",
        cancelMarkup(),
      );
      return;
    }

    await this.createIdealOutfitPlanRequest(message);
  }

  private async handleIdealOutfitChoiceStep(
    message: TelegramMessage,
    session: Extract<ChatSession, { mode: "awaiting-ideal-outfit-choice" }>,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? message.caption?.trim();
    const selectedIndex = text ? parseIdealOutfitChoice(text, session.outfits) : -1;

    if (selectedIndex < 0) {
      await this.sendMessage(
        chatId,
        "Выберите один из предложенных образов кнопкой ниже или нажмите «Отмена».",
        idealOutfitChoiceMarkup(session.outfits),
      );
      return;
    }

    await this.createIdealProductSearchRequest(
      chatId,
      session,
      session.outfits[selectedIndex],
    );
  }

  private async createAppearanceAnalysisRequest(
    message: TelegramMessage,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    let pendingJobId: string | undefined;

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
        files: logStorageFiles(inputFiles),
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
      const jobId = getResponseJobId(assignment);
      pendingJobId = jobId;

      this.pendingJobs.set(jobId, {
        flow: "appearance",
        chatId,
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
          processingMarkup(),
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
        processingMarkup(),
      );
    } catch (error) {
      if (pendingJobId) {
        this.pendingJobs.delete(pendingJobId);
      }
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

  private async createIdealOutfitPlanRequest(
    message: TelegramMessage,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    let pendingJobId: string | undefined;

    try {
      logger.info("Ideal outfit full-body photo received", {
        chatId,
        photoVariants: message.photo?.length ?? 0,
      });
      const inputFiles = await this.uploadMessagePhotos(message);

      if (!inputFiles?.length) {
        throw new Error("No Telegram photos were uploaded for ideal outfit");
      }

      logger.info("Ideal outfit storage upload completed", {
        chatId,
        files: logStorageFiles(inputFiles),
      });
      const assignment = await this.coordinator.createRequestJob({
        chatId,
        username: message.from?.username,
        text: idealOutfitPlanPrompt,
        model: createIdealOutfitPlanModelSelection(),
        inputFiles,
      });
      const jobId = getResponseJobId(assignment);
      pendingJobId = jobId;

      this.pendingJobs.set(jobId, {
        flow: "ideal-plan",
        chatId,
        inputFiles,
        username: message.from?.username,
      });
      this.sessions.delete(chatId);

      if (isQueuedJobResponse(assignment)) {
        await this.sendMessage(
          chatId,
          `Фото принято. Запрос ${assignment.job.id} поставлен в очередь, скоро соберу варианты образов.`,
          processingMarkup(),
        );
        void this.waitForAssignmentAndDispatch(
          chatId,
          assignment.job.id,
          assignment.retryAfterMs,
        );
        return;
      }

      await this.worker.dispatchJob(assignment);
      logger.info("Ideal outfit plan job dispatched", {
        chatId,
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
      });
      await this.sendMessage(
        chatId,
        `Фото принято. Запрос ${assignment.job.id} отправлен на сервер. Собираю варианты образов.`,
        processingMarkup(),
      );
    } catch (error) {
      if (pendingJobId) {
        this.pendingJobs.delete(pendingJobId);
      }
      logger.error("Failed to create ideal outfit plan job", {
        chatId,
        error,
      });
      await this.sendMessage(
        chatId,
        "Не удалось отправить фото на подбор образа. Попробуйте еще раз или нажмите «Отмена».",
        cancelMarkup(),
      );
    }
  }

  private async handleIdealPlanCallback(
    pending: Extract<PendingJob, { flow: "ideal-plan" }>,
    message: string,
  ): Promise<void> {
    const parsed = parseJsonFromOpenAiMessage<IdealPlanResponse>(message);

    if (!parsed || parsed.ok !== true) {
      this.sessions.set(pending.chatId, {
        mode: "awaiting-ideal-full-body-photo",
      });
      await this.sendMessage(
        pending.chatId,
        parsed?.errorMessage ??
          "Не получилось надежно понять фото. Пришлите фото почти в полный рост, где хорошо видны голова, корпус и большая часть ног.",
        cancelMarkup(),
      );
      return;
    }

    const outfits = sanitizeIdealOutfits(parsed.outfits, {
      allowFootwear: parsed.footwearVisible !== false,
    });

    if (outfits.length === 0) {
      this.sessions.set(pending.chatId, {
        mode: "awaiting-ideal-full-body-photo",
      });
      await this.sendMessage(
        pending.chatId,
        "Не удалось собрать достаточно внятные варианты. Пришлите другое фото почти в полный рост.",
        cancelMarkup(),
      );
      return;
    }

    this.sessions.set(pending.chatId, {
      mode: "awaiting-ideal-outfit-choice",
      outfits,
      inputFiles: pending.inputFiles,
      username: pending.username,
    });

    await this.sendMessage(
      pending.chatId,
      formatIdealOutfitOptions(parsed.summary, outfits, {
        footwearVisible: parsed.footwearVisible !== false,
      }),
      idealOutfitChoiceMarkup(outfits),
    );
  }

  private async createIdealProductSearchRequest(
    chatId: string,
    session: Extract<ChatSession, { mode: "awaiting-ideal-outfit-choice" }>,
    outfit: IdealOutfit,
  ): Promise<void> {
    const searchState: IdealMarketSearchState = {
      chatId,
      outfit,
      inputFiles: session.inputFiles,
      totalJobs: outfit.items.length * idealMarketProviders.length,
      completedJobs: 0,
      candidates: [],
      missingItems: [],
    };
    const pendingJobIds: string[] = [];

    try {
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: outfit.title,
          search: "создаю запрос",
          validation: "ожидает",
          generation: "ожидает",
        }),
      );
      logger.info("Ideal outfit product search requested", {
        chatId,
        outfitId: outfit.id,
        outfitTitle: outfit.title,
        items: outfit.items.map((item) => ({
          slot: item.slot,
          category: item.category,
          searchQuery: item.searchQuery,
        })),
      });
      this.sessions.delete(chatId);

      let launchedJobs = 0;

      for (const [index, item] of outfit.items.entries()) {
        for (const marketProvider of idealMarketProviders) {
          try {
            const assignment = await this.coordinator.createRequestJob({
              chatId,
              username: session.username,
              text: createIdealMarketSearchText(outfit, item, marketProvider),
              model: createIdealMarketSearchModelSelection(),
              market: createIdealMarketSearchSelection(item, marketProvider),
            });
            const jobId = getResponseJobId(assignment);
            pendingJobIds.push(jobId);
            launchedJobs += 1;

            this.pendingJobs.set(jobId, {
              flow: "ideal-products",
              chatId,
              outfit,
              inputFiles: session.inputFiles,
              item,
              marketProvider,
              searchState,
            });

            if (isQueuedJobResponse(assignment)) {
              await this.updateIdealProgressMessage(
                chatId,
                formatIdealProductProgress({
                  lookTitle: outfit.title,
                  search: `в очереди ${launchedJobs}/${searchState.totalJobs}: ${marketplaceName(marketProvider)}, ${item.category}`,
                  validation: "ожидает",
                  generation: "ожидает",
                }),
              );
              void this.waitForAssignmentAndDispatch(
                chatId,
                assignment.job.id,
                assignment.retryAfterMs,
              );
              continue;
            }

            await this.worker.dispatchJob(assignment);
            logger.info("Ideal outfit market products job dispatched", {
              chatId,
              jobId: assignment.job.id,
              workerId: assignment.worker.workerId,
              outfitId: outfit.id,
              marketProvider,
              slot: item.slot,
              category: item.category,
            });
          } catch (error) {
            searchState.completedJobs += 1;
            logger.error("Failed to create ideal market product search job", {
              chatId,
              outfitId: outfit.id,
              marketProvider,
              slot: item.slot,
              category: item.category,
              error,
            });
          }

          await this.updateIdealProgressMessage(
            chatId,
            formatIdealProductProgress({
              lookTitle: outfit.title,
              search: `запущено ${Math.min(launchedJobs, searchState.totalJobs)}/${searchState.totalJobs}`,
              validation: "ожидает",
              generation: "ожидает",
            }),
          );
        }
      }

      if (pendingJobIds.length === 0 || searchState.completedJobs >= searchState.totalJobs) {
        await this.finishIdealMarketProductSearch(searchState);
        return;
      }

      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: outfit.title,
          search: `выполняется через API Ozon/Wildberries: 0/${searchState.totalJobs}`,
          validation: "ожидает",
          generation: "ожидает",
        }),
      );
    } catch (error) {
      for (const jobId of pendingJobIds) {
        this.pendingJobs.delete(jobId);
      }
      logger.error("Failed to create ideal product search job", {
        chatId,
        outfitId: outfit.id,
        error,
      });
      this.clearIdealProgressMessage(chatId);
      await this.sendMessage(
        chatId,
        "Не удалось запустить поиск товаров. Попробуйте выбрать образ еще раз.",
        idealOutfitChoiceMarkup(session.outfits),
      );
    }
  }

  private async handleIdealProductsCallback(
    pending: Extract<PendingJob, { flow: "ideal-products" }>,
    callback: TelegramJobCallbackRequest,
  ): Promise<void> {
    const products = marketProductsToIdealProducts(
      callback.result.marketProducts ?? [],
      pending.item,
    );
    const searchState = pending.searchState;

    if (products.length > 0) {
      searchState.candidates.push(...products);
    }

    searchState.completedJobs += 1;
    logger.info("Ideal outfit market product search parsed", {
      chatId: pending.chatId,
      outfitId: pending.outfit.id,
      jobId: callback.jobId,
      marketProvider: pending.marketProvider,
      slot: pending.item.slot,
      category: pending.item.category,
      rawProducts: callback.result.marketProducts?.length ?? 0,
      convertedProducts: products.length,
      completedJobs: searchState.completedJobs,
      totalJobs: searchState.totalJobs,
    });

    await this.updateIdealProgressMessage(
      pending.chatId,
      formatIdealProductProgress({
        lookTitle: pending.outfit.title,
        search: `выполняется через API Ozon/Wildberries: ${Math.min(searchState.completedJobs, searchState.totalJobs)}/${searchState.totalJobs}, найдено ${formatCandidateCount(searchState.candidates.length)}`,
        validation: "ожидает",
        generation: "ожидает",
      }),
    );

    if (searchState.completedJobs < searchState.totalJobs) {
      return;
    }

    await this.finishIdealMarketProductSearch(searchState);
  }

  private async finishIdealMarketProductSearch(
    searchState: IdealMarketSearchState,
  ): Promise<void> {
    const candidates = sanitizeIdealProducts(searchState.candidates, {
      allowedItems: searchState.outfit.items,
      requireCleanCardReady: false,
      allowMultiplePerCategory: true,
      maxProducts: maxIdealProductCandidates(searchState.outfit),
    });
    const missingItems = mergeMissingItems(
      searchState.missingItems,
      buildMissingItemsFromOutfit(searchState.outfit, candidates),
    );

    logger.info("Ideal outfit market product search completed", {
      chatId: searchState.chatId,
      outfitId: searchState.outfit.id,
      rawCandidates: searchState.candidates.length,
      filteredCandidates: candidates.length,
      missingItems: missingItems.length,
    });

    if (candidates.length === 0) {
      await this.updateIdealProgressMessage(
        searchState.chatId,
        formatIdealProductProgress({
          lookTitle: searchState.outfit.title,
          search: "готово, API Ozon/Wildberries не дали подходящих кандидатов",
          validation: "не запускалась",
          generation: "не запускалась",
        }),
      );
      this.clearIdealProgressMessage(searchState.chatId);
      await this.sendMessage(
        searchState.chatId,
        formatMissingProductsMessage(
          searchState.outfit,
          [],
          missingItems,
          "Не нашел кандидаты товаров через API Ozon/Wildberries для этого образа.",
        ),
        mainMenuMarkup(),
      );
      return;
    }

    await this.updateIdealProgressMessage(
      searchState.chatId,
      formatIdealProductProgress({
        lookTitle: searchState.outfit.title,
        search: `готово, найдено ${formatCandidateCount(candidates.length)} через API Ozon/Wildberries`,
        validation: "создаю запрос проверки",
        generation: "ожидает",
      }),
    );
    await this.createIdealProductValidationRequest(
      searchState,
      candidates,
      missingItems,
    );
  }

  private async createIdealProductValidationRequest(
    pending: {
      chatId: string;
      outfit: IdealOutfit;
      inputFiles: StorageObjectRef[];
    },
    candidates: IdealProduct[],
    missingItems: IdealMissingItem[],
  ): Promise<void> {
    let pendingJobId: string | undefined;

    try {
      logger.info("Ideal outfit product image validation requested", {
        chatId: pending.chatId,
        outfitId: pending.outfit.id,
        candidates: candidates.length,
      });
      const assignment = await this.coordinator.createRequestJob({
        chatId: pending.chatId,
        text: createIdealProductValidationPrompt(pending.outfit, candidates),
        model: createIdealProductValidationModelSelection(candidates),
        inputFiles: pending.inputFiles,
      });
      const jobId = getResponseJobId(assignment);
      pendingJobId = jobId;

      this.pendingJobs.set(jobId, {
        flow: "ideal-products-validation",
        chatId: pending.chatId,
        outfit: pending.outfit,
        inputFiles: pending.inputFiles,
        candidates,
        missingItems,
      });

      if (isQueuedJobResponse(assignment)) {
        await this.updateIdealProgressMessage(
          pending.chatId,
          formatIdealProductProgress({
            lookTitle: pending.outfit.title,
            search: `готово, найдено ${formatCandidateCount(candidates.length)}`,
            validation: `в очереди, запрос ${assignment.job.id}`,
            generation: "ожидает",
          }),
        );
        void this.waitForAssignmentAndDispatch(
          pending.chatId,
          assignment.job.id,
          assignment.retryAfterMs,
        );
        return;
      }

      await this.worker.dispatchJob(assignment);
      logger.info("Ideal outfit product validation job dispatched", {
        chatId: pending.chatId,
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
        outfitId: pending.outfit.id,
      });
      await this.updateIdealProgressMessage(
        pending.chatId,
        formatIdealProductProgress({
          lookTitle: pending.outfit.title,
          search: `готово, найдено ${formatCandidateCount(candidates.length)}`,
          validation: "выполняется на сервере",
          generation: "ожидает",
        }),
      );
    } catch (error) {
      if (pendingJobId) {
        this.pendingJobs.delete(pendingJobId);
      }
      logger.error("Failed to create ideal product validation job", {
        chatId: pending.chatId,
        outfitId: pending.outfit.id,
        error,
      });
      await this.updateIdealProgressMessage(
        pending.chatId,
        formatIdealProductProgress({
          lookTitle: pending.outfit.title,
          search: `готово, найдено ${formatCandidateCount(candidates.length)}`,
          validation: "не удалось запустить проверку",
          generation: "не запускалась",
        }),
      );
      this.clearIdealProgressMessage(pending.chatId);
      await this.sendMessage(
        pending.chatId,
        "Не удалось проверить фото товаров. Попробуйте выбрать образ еще раз.",
        mainMenuMarkup(),
      );
    }
  }

  private async handleIdealProductValidationCallback(
    pending: Extract<PendingJob, { flow: "ideal-products-validation" }>,
    callback: TelegramJobCallbackRequest,
  ): Promise<void> {
    const parsed = parseJsonFromOpenAiMessage<IdealProductValidationResponse>(
      callback.result.message,
    );

    if (!parsed || parsed.ok !== true) {
      logger.warn("Ideal outfit product validation failed, using fallback candidates", {
        chatId: pending.chatId,
        outfitId: pending.outfit.id,
        candidates: pending.candidates.length,
        responseStart: callback.result.message.slice(0, 300),
      });
      await this.startIdealProductCardGeneration(
        pending.chatId,
        pending.outfit,
        selectFallbackIdealProducts(pending.candidates, pending.outfit.items),
        mergeMissingItems(
          pending.missingItems,
          sanitizeIdealMissingItems(parsed?.missingItems),
        ),
        pending.inputFiles,
        "Не получилось проверить изображения товаров пачкой, поэтому пробую собрать карточки по найденным кандидатам.",
      );
      return;
    }

    const products = selectAcceptedIdealProducts(
      pending.candidates,
      parsed.acceptedCandidates,
      pending.outfit.items,
    );
    logger.info("Ideal outfit product validation parsed", {
      chatId: pending.chatId,
      outfitId: pending.outfit.id,
      candidates: pending.candidates.length,
      acceptedRaw: Array.isArray(parsed.acceptedCandidates)
        ? parsed.acceptedCandidates.length
        : 0,
      acceptedProducts: products.length,
    });
    const missingItems = mergeMissingItems(
      pending.missingItems,
      sanitizeIdealMissingItems(parsed.missingItems),
      buildMissingItemsFromOutfit(pending.outfit, products),
    );

    if (products.length === 0) {
      logger.warn("Ideal outfit product validation accepted no products, using fallback candidates", {
        chatId: pending.chatId,
        outfitId: pending.outfit.id,
        candidates: pending.candidates.length,
      });
      await this.startIdealProductCardGeneration(
        pending.chatId,
        pending.outfit,
        selectFallbackIdealProducts(pending.candidates, pending.outfit.items),
        missingItems,
        pending.inputFiles,
        "Проверка фото не приняла кандидаты уверенно, поэтому пробую собрать карточки по лучшим найденным товарам.",
      );
      return;
    }

    await this.startIdealProductCardGeneration(
      pending.chatId,
      pending.outfit,
      products,
      missingItems,
      pending.inputFiles,
    );
  }

  private async startIdealProductCardGeneration(
    chatId: string,
    outfit: IdealOutfit,
    products: IdealProduct[],
    missingItems: IdealMissingItem[],
    inputFiles: StorageObjectRef[],
    fallbackMessage?: string,
  ): Promise<void> {
    if (products.length === 0) {
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: outfit.title,
          search: "готово",
          validation: "товары не прошли проверку",
          generation: "не запускалась",
          note:
            fallbackMessage ??
            "Не осталось товаров после проверки фото: не нашлось кандидатов, из которых можно надежно сделать чистую карточку товара.",
        }),
      );
      this.clearIdealProgressMessage(chatId);
      await this.sendMessage(
        chatId,
        formatMissingProductsMessage(
          outfit,
          products,
          missingItems,
          fallbackMessage ??
            "Не осталось товаров после проверки фото: не нашлось кандидатов, из которых можно надежно сделать чистую карточку товара.",
        ),
        mainMenuMarkup(),
      );
      return;
    }

    if (fallbackMessage) {
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: outfit.title,
          search: "готово",
          validation: "использую fallback-кандидаты",
          generation: "готовлю генерацию",
          note: fallbackMessage,
        }),
      );
    }

    const [firstProduct, ...remainingProducts] = products;

    if (!firstProduct) {
      await this.sendMessage(
        chatId,
        formatMissingProductsMessage(
          outfit,
          [],
          missingItems,
          "Не осталось товаров после проверки фото.",
        ),
        mainMenuMarkup(),
      );
      return;
    }

    await this.updateIdealProgressMessage(
      chatId,
      formatIdealProductProgress({
        lookTitle: outfit.title,
        search: "готово",
        validation: "готово",
        generation: `готовлю товар 1/${products.length}: ${firstProduct.category}`,
      }),
    );
    await this.createIdealProductCardGenerationRequest(
      chatId,
      outfit,
      firstProduct,
      remainingProducts,
      [],
      missingItems,
      inputFiles,
    );
  }

  private async createIdealProductCardGenerationRequest(
    chatId: string,
    outfit: IdealOutfit,
    product: IdealProduct,
    remainingProducts: IdealProduct[],
    generatedProducts: IdealProduct[],
    missingItems: IdealMissingItem[],
    inputFiles: StorageObjectRef[],
  ): Promise<void> {
    let pendingJobId: string | undefined;
    const totalProducts =
      generatedProducts.length + remainingProducts.length + 1;
    const currentProductIndex = generatedProducts.length + 1;

    const cachedProduct = await this.getCachedIdealProductCard(
      chatId,
      product,
    );

    if (cachedProduct) {
      logger.info("Ideal outfit clean product card cache hit", {
        chatId,
        outfitId: outfit.id,
        category: product.category,
        title: product.title,
        productUrl: product.productUrl,
      });
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: outfit.title,
          search: "готово",
          validation: "готово",
          generation: `готово ${generatedProducts.length + 1}/${totalProducts}, взято из кэша: ${product.category}`,
        }),
      );
      await this.continueOrDeliverGeneratedProducts({
        chatId,
        outfit,
        remainingProducts,
        generatedProducts: [...generatedProducts, cachedProduct],
        missingItems,
        inputFiles,
      });
      return;
    }

    try {
      logger.info("Ideal outfit clean product card generation requested", {
        chatId,
        outfitId: outfit.id,
        category: product.category,
        title: product.title,
      });
      const assignment = await this.coordinator.createRequestJob({
        chatId,
        text: createIdealProductCardGenerationPrompt(product),
        model: createIdealProductCardGenerationModelSelection(product),
        inputFiles,
      });
      const jobId = getResponseJobId(assignment);
      pendingJobId = jobId;

      this.pendingJobs.set(jobId, {
        flow: "ideal-product-card-generation",
        chatId,
        outfit,
        product,
        remainingProducts,
        generatedProducts,
        missingItems,
        inputFiles,
      });

      if (isQueuedJobResponse(assignment)) {
        await this.updateIdealProgressMessage(
          chatId,
          formatIdealProductProgress({
            lookTitle: outfit.title,
            search: "готово",
            validation: "готово",
            generation: `в очереди, товар ${currentProductIndex}/${totalProducts}: ${product.category}, запрос ${assignment.job.id}`,
          }),
        );
        void this.waitForAssignmentAndDispatch(
          chatId,
          assignment.job.id,
          assignment.retryAfterMs,
        );
        return;
      }

      await this.worker.dispatchJob(assignment);
      logger.info("Ideal outfit clean product card generation job dispatched", {
        chatId,
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
        category: product.category,
      });
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: outfit.title,
          search: "готово",
          validation: "готово",
          generation: `выполняется, товар ${currentProductIndex}/${totalProducts}: ${product.category}`,
        }),
      );
    } catch (error) {
      if (pendingJobId) {
        this.pendingJobs.delete(pendingJobId);
      }
      logger.error("Failed to create clean product card generation job", {
        chatId,
        category: product.category,
        error,
      });
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: outfit.title,
          search: "готово",
          validation: "готово",
          generation: `ошибка запуска для товара ${currentProductIndex}/${totalProducts}: ${product.category}`,
        }),
      );
      await this.continueOrDeliverGeneratedProducts({
        chatId,
        outfit,
        remainingProducts,
        generatedProducts,
        missingItems: mergeMissingItems(missingItems, [
          {
            slot: product.slot,
            category: product.category,
            reason: "Не удалось запустить генерацию чистой карточки товара",
          },
        ]),
        inputFiles,
      });
    }
  }

  private async handleIdealProductCardGenerationCallback(
    pending: Extract<PendingJob, { flow: "ideal-product-card-generation" }>,
    callback: TelegramJobCallbackRequest,
  ): Promise<void> {
    const generatedFile = callback.result.files?.find((file) => file.url);
    const cachedFile = generatedFile
      ? await this.cacheIdealProductCard(pending.chatId, pending.product, generatedFile)
      : undefined;
    const productCardFile = cachedFile ?? generatedFile;
    const generatedProducts = productCardFile?.url
      ? [
          ...pending.generatedProducts,
          {
            ...pending.product,
            originalImageUrl:
              pending.product.originalImageUrl ?? pending.product.imageUrl,
            imageUrl: productCardFile.url,
          },
        ]
      : pending.generatedProducts;
    const missingItems = productCardFile?.url
      ? pending.missingItems
      : mergeMissingItems(pending.missingItems, [
          {
            slot: pending.product.slot,
            category: pending.product.category,
            reason: "Не удалось получить сгенерированную чистую карточку товара",
          },
        ]);
    const totalProducts =
      pending.generatedProducts.length + pending.remainingProducts.length + 1;
    await this.updateIdealProgressMessage(
      pending.chatId,
      formatIdealProductProgress({
        lookTitle: pending.outfit.title,
        search: "готово",
        validation: "готово",
        generation: productCardFile?.url
          ? `готово ${generatedProducts.length}/${totalProducts}, продолжаю`
          : `не удалось сгенерировать ${pending.product.category}, продолжаю`,
      }),
    );

    await this.continueOrDeliverGeneratedProducts({
      chatId: pending.chatId,
      outfit: pending.outfit,
      remainingProducts: pending.remainingProducts,
      generatedProducts,
      missingItems,
      inputFiles: pending.inputFiles,
    });
  }

  private async continueOrDeliverGeneratedProducts(params: {
    chatId: string;
    outfit: IdealOutfit;
    remainingProducts: IdealProduct[];
    generatedProducts: IdealProduct[];
    missingItems: IdealMissingItem[];
    inputFiles: StorageObjectRef[];
  }): Promise<void> {
    const [nextProduct, ...remainingProducts] = params.remainingProducts;

    if (nextProduct) {
      await this.createIdealProductCardGenerationRequest(
        params.chatId,
        params.outfit,
        nextProduct,
        remainingProducts,
        params.generatedProducts,
        params.missingItems,
        params.inputFiles,
      );
      return;
    }

    await this.deliverIdealProducts(
      params.chatId,
      params.outfit.title,
      params.generatedProducts,
      mergeMissingItems(
        params.missingItems,
        buildMissingItemsFromOutfit(params.outfit, params.generatedProducts),
      ),
    );
  }

  private async deliverIdealProducts(
    chatId: string,
    lookTitle: string,
    products: IdealProduct[],
    missingItems: IdealMissingItem[],
  ): Promise<void> {
    if (products.length === 0) {
      await this.updateIdealProgressMessage(
        chatId,
        formatMissingProductsMessage(
          {
            id: "look",
            title: lookTitle,
            summary: "",
            items: [],
          },
          products,
          missingItems,
          "Не удалось подготовить чистые карточки товаров для этого образа.",
        ),
      );
      this.clearIdealProgressMessage(chatId);
      await this.sendMessage(
        chatId,
        formatMissingProductsMessage(
          {
            id: "look",
            title: lookTitle,
            summary: "",
            items: [],
          },
          products,
          missingItems,
          "Не удалось подготовить чистые карточки товаров для этого образа.",
        ),
        mainMenuMarkup(),
      );
      return;
    }

    await this.updateIdealProgressMessage(
      chatId,
      formatProductSelectionIntro(lookTitle, products, missingItems),
    );

    let delivered = 0;

    for (const product of products) {
      try {
        await this.sendPhoto(
          chatId,
          product.imageUrl,
          formatProductCaption(product),
          productCardMarkup(product),
        );
        delivered += 1;
      } catch (error) {
        logger.warn("Failed to send product photo, product skipped", {
          chatId,
          title: product.title,
          imageUrl: redactUrlQuery(product.imageUrl),
          productUrl: product.productUrl,
          error,
        });
      }
    }

    if (delivered === 0) {
      await this.updateIdealProgressMessage(
        chatId,
        `${formatProductSelectionIntro(lookTitle, products, missingItems)}\n\nКарточки нашлись, но Telegram не смог загрузить их изображения.`,
      );
      this.clearIdealProgressMessage(chatId);
      await this.sendMessage(
        chatId,
        "Карточки нашлись, но Telegram не смог загрузить их изображения. Попробуйте другой образ.",
        mainMenuMarkup(),
      );
      return;
    }

    await this.updateIdealProgressMessage(
      chatId,
      `${formatProductSelectionIntro(lookTitle, products, missingItems)}\n\nОтправлено карточек: ${delivered}.`,
    );
    this.clearIdealProgressMessage(chatId);
    await this.sendMessage(chatId, "Подборка готова.", mainMenuMarkup());

    logger.info("Ideal outfit products delivered", {
      chatId,
      delivered,
      received: products.length,
      missing: missingItems.length,
    });
  }

  private async createRequest(
    message: TelegramMessage,
    request: ParsedRequestCommand,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    let pendingJobId: string | undefined;

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
      const jobId = getResponseJobId(assignment);
      pendingJobId = jobId;

      this.pendingJobs.set(jobId, {
        flow: "legacy",
        chatId,
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
          processingMarkup(),
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
        processingMarkup(),
      );
    } catch (error) {
      if (pendingJobId) {
        this.pendingJobs.delete(pendingJobId);
      }
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
    const maxAttempts =
      this.pendingJobs.get(jobId)?.flow === "ideal-products" ? 12 : 120;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
        this.logScenarioJobDispatched(
          chatId,
          assignment.job.id,
          assignment.worker.workerId,
        );
        if (await this.updateQueuedIdealProgress(chatId, assignment.job.id)) {
          return;
        }
        await this.sendMessage(
          chatId,
          `Запрос ${assignment.job.id} отправлен на сервер. Ожидаю ответ.`,
          processingMarkup(),
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

    const pending = this.pendingJobs.get(jobId);
    if (pending?.flow === "ideal-products") {
      this.pendingJobs.delete(jobId);
      pending.searchState.completedJobs += 1;
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: pending.outfit.title,
          search: `очередь API-поиска не освободилась: ${Math.min(pending.searchState.completedJobs, pending.searchState.totalJobs)}/${pending.searchState.totalJobs}`,
          validation: "ожидает",
          generation: "ожидает",
        }),
      );

      if (pending.searchState.completedJobs >= pending.searchState.totalJobs) {
        await this.finishIdealMarketProductSearch(pending.searchState);
      }

      logger.warn("Queued ideal market job polling exhausted", {
        chatId,
        jobId,
        outfitId: pending.outfit.id,
        marketProvider: pending.marketProvider,
        slot: pending.item.slot,
        category: pending.item.category,
      });
      return;
    }

    if (
      pending?.flow === "ideal-products-validation" ||
      pending?.flow === "ideal-product-card-generation"
    ) {
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: pending.outfit.title,
          search: "очередь не освободилась",
          validation: "проверьте позже",
          generation: "проверьте позже",
        }),
      );
      this.clearIdealProgressMessage(chatId);
    }
    await this.sendMessage(
      chatId,
      `Запрос ${jobId} все еще в очереди. Попробуйте проверить позже.`,
      mainMenuMarkup(),
    );
    this.pendingJobs.delete(jobId);
    logger.warn("Queued job polling exhausted", {
      chatId,
      jobId,
    });
  }

  private async updateQueuedIdealProgress(
    chatId: string,
    jobId: string,
  ): Promise<boolean> {
    const pending = this.pendingJobs.get(jobId);

    if (pending?.flow === "ideal-products") {
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: pending.outfit.title,
          search: `выполняется через ${marketplaceName(pending.marketProvider)}: ${pending.searchState.completedJobs}/${pending.searchState.totalJobs}, товар: ${pending.item.category}`,
          validation: "ожидает",
          generation: "ожидает",
        }),
      );
      return true;
    }

    if (pending?.flow === "ideal-products-validation") {
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: pending.outfit.title,
          search: `готово, найдено ${formatCandidateCount(pending.candidates.length)}`,
          validation: "выполняется на сервере",
          generation: "ожидает",
        }),
      );
      return true;
    }

    if (pending?.flow === "ideal-product-card-generation") {
      const totalProducts =
        pending.generatedProducts.length + pending.remainingProducts.length + 1;
      const currentProductIndex = pending.generatedProducts.length + 1;
      await this.updateIdealProgressMessage(
        chatId,
        formatIdealProductProgress({
          lookTitle: pending.outfit.title,
          search: "готово",
          validation: "готово",
          generation: `выполняется, товар ${currentProductIndex}/${totalProducts}: ${pending.product.category}`,
        }),
      );
      return true;
    }

    return false;
  }

  private logScenarioJobDispatched(
    chatId: string,
    jobId: string,
    workerId: string,
  ): void {
    const pending = this.pendingJobs.get(jobId);

    if (pending?.flow === "appearance") {
      logger.info("Appearance analysis job dispatched", {
        chatId,
        jobId,
        workerId,
      });
      return;
    }

    if (pending?.flow === "ideal-plan") {
      logger.info("Ideal outfit plan job dispatched", {
        chatId,
        jobId,
        workerId,
      });
      return;
    }

    if (pending?.flow === "ideal-products") {
      logger.info("Ideal outfit market products job dispatched", {
        chatId,
        jobId,
        workerId,
        outfitId: pending.outfit.id,
        marketProvider: pending.marketProvider,
        slot: pending.item.slot,
        category: pending.item.category,
      });
      return;
    }

    if (pending?.flow === "ideal-products-validation") {
      logger.info("Ideal outfit product validation job dispatched", {
        chatId,
        jobId,
        workerId,
        outfitId: pending.outfit.id,
      });
    }
  }

  private setupCommands(): Promise<unknown> {
    const commands: BotCommand[] = [
      {
        command: "start",
        description: "Запустить бота",
      },
      {
        command: "appearance",
        description: "Анализ внешности по фото",
      },
      {
        command: "ideal",
        description: "Подобрать идеальный образ",
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

  private async callMultipartApi<T = unknown>(
    method: string,
    form: FormData,
  ): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/${method}`,
      {
        method: "POST",
        body: form,
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

function getResponseJobId(response: TryOnJobCreateResponse): string {
  return response.job.id;
}

function logStorageFiles(files: StorageObjectRef[]): Record<string, unknown>[] {
  return files.map((file) => ({
    storageId: file.storageId,
    key: file.key,
    sizeBytes: file.sizeBytes,
    contentType: file.contentType,
  }));
}

function mainMenuMarkup(): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: appearanceAnalysisButtonText }, { text: idealOutfitButtonText }],
    ],
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

function processingMarkup(): TelegramReplyMarkup {
  return {
    remove_keyboard: true,
  };
}

function idealOutfitChoiceMarkup(outfits: IdealOutfit[]): TelegramReplyMarkup {
  return {
    keyboard: [
      ...outfits.map((_, index) => [{ text: `Образ ${index + 1}` }]),
      [{ text: cancelButtonText }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function productCardMarkup(product: IdealProduct): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Перейти к товару",
          url: product.productUrl,
        },
      ],
    ],
  };
}

function isAppearanceAnalysisCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);

  return (
    normalized === normalizeCommandText(appearanceAnalysisButtonText) ||
    normalized === normalizeCommandText(legacyAppearanceAnalysisButtonText) ||
    normalized === "/appearance"
  );
}

function isIdealOutfitCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);

  return (
    normalized === normalizeCommandText(idealOutfitButtonText) ||
    normalized === "/ideal"
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

function isInterruptingCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);

  return (
    normalized.startsWith("/") ||
    normalized === "request" ||
    isAppearanceAnalysisCommand(text) ||
    isIdealOutfitCommand(text) ||
    parseRequestCommand(text) !== undefined
  );
}

function normalizeCommandText(text: string): string {
  return text.trim().toLowerCase();
}

function describePendingJob(pending: PendingJob): string {
  if (pending.flow === "appearance") {
    return "анализ внешности";
  }

  if (pending.flow === "legacy") {
    return "обработка запроса";
  }

  if (pending.flow === "ideal-plan") {
    return "подбор вариантов образа";
  }

  if (pending.flow === "ideal-products") {
    return "поиск товаров для образа";
  }

  return "проверка фото товаров";
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

function createIdealOutfitPlanModelSelection(): TryOnModelSelection {
  return {
    provider: "openai",
    task: "wardrobe-recommendation",
    options: {
      imageDetail: "high",
      textVerbosity: "low",
      reasoningEffort: "low",
      reasoningMode: "standard",
      maxOutputTokens: 1_800,
      store: false,
    },
  };
}

function maxIdealProductCandidates(outfit: IdealOutfit): number {
  return Math.min(
    Math.max(1, outfit.items.length * idealCandidatesPerOutfitItem),
    80,
  );
}

function compactOutfitForPrompt(outfit: IdealOutfit): Record<string, unknown> {
  return {
    title: outfit.title,
    items: outfit.items.map((item) => ({
      slot: item.slot,
      category: item.category,
      color: item.color,
      description: item.description,
      searchQuery: item.searchQuery,
    })),
  };
}

function createIdealMarketSearchModelSelection(): TryOnModelSelection {
  return {
    provider: "mock",
    task: "wardrobe-recommendation",
  };
}

function createIdealMarketSearchSelection(
  item: IdealOutfitItem,
  provider: MarketProvider,
): MarketSearchSelection {
  return {
    providers: [provider],
    query: createIdealMarketSearchQuery(item),
    category: createIdealMarketCategory(item),
    limit: idealCandidatesPerMarketProvider,
    currency: "RUB",
    locale: "ru-RU",
    country: "RU",
    required: true,
  };
}

function createIdealMarketSearchText(
  outfit: IdealOutfit,
  item: IdealOutfitItem,
  provider: MarketProvider,
): string {
  return [
    `Market search for outfit: ${outfit.title}`,
    `Provider: ${provider}`,
    `Slot: ${item.slot}`,
    `Category: ${item.category}`,
    `Description: ${item.description}`,
    `Search query: ${item.searchQuery}`,
  ].join("\n");
}

function createIdealMarketSearchQuery(item: IdealOutfitItem): string {
  return createIdealMarketCategory(item);
}

function createIdealMarketCategory(item: IdealOutfitItem): string {
  return (
    [
      idealMarketSearchTerm(item),
      item.category.trim(),
      item.searchQuery.trim(),
      item.description.trim(),
    ].find((value): value is string => Boolean(value)) ?? item.category
  );
}

function idealMarketSearchTerm(item: IdealOutfitItem): string | undefined {
  const key = normalizeCategoryKey(
    [item.category, item.slot, item.searchQuery, item.description].join(" "),
  );
  const terms: Record<string, string> = {
    top: "футболка",
    bottom: "брюки",
    layer: "кардиган",
    outerwear: "куртка",
    vest: "жилет",
    polo: "поло",
    cardigan: "кардиган",
    sweater: "джемпер",
    hoodie: "худи",
    jacket: "куртка",
    shirt: "рубашка",
    tshirt: "футболка",
    coat: "пальто",
    pants: "брюки",
    shorts: "шорты",
    skirt: "юбка",
    dress: "платье",
    shoes: "обувь",
    bag: "сумка",
    accessory: "аксессуар",
  };

  return terms[key];
}

function createIdealProductValidationModelSelection(
  candidates: IdealProduct[],
): TryOnModelSelection {
  return {
    provider: "openai",
    task: "wardrobe-recommendation",
    options: {
      imageDetail: "low",
      textVerbosity: "low",
      reasoningEffort: "low",
      reasoningMode: "standard",
      maxOutputTokens: Math.min(900 + candidates.length * 45, 3_000),
      store: false,
      inputImageUrls: candidates.map((candidate) => candidate.imageUrl),
      maxInputImageUrls: candidates.length,
      allowInputImagePlaceholders: true,
    },
  };
}

function createIdealProductCardGenerationModelSelection(
  product: IdealProduct,
): TryOnModelSelection {
  return {
    provider: "openai",
    task: "wardrobe-recommendation",
    options: {
      imageDetail: "low",
      textVerbosity: "low",
      reasoningEffort: "low",
      reasoningMode: "standard",
      maxOutputTokens: 300,
      store: false,
      toolChoice: "required",
      inputImageUrls: [product.imageUrl],
      maxInputImageUrls: 1,
      imageGeneration: {
        model: "gpt-image-1",
        quality: "medium",
        size: "1024x1536",
        background: "opaque",
        outputFormat: "png",
        inputFidelity: "low",
      },
    },
  };
}

function createIdealProductValidationPrompt(
  outfit: IdealOutfit,
  candidates: IdealProduct[],
): string {
  const compactCandidates = candidates.map((candidate, index) => ({
    i: index + 1,
    s: candidate.slot,
    c: candidate.category,
    t: truncateText(candidate.title, 90),
    src: candidate.source,
  }));

  return `
Быстро проверь product images для последующей генерации clean product card.
Image 0 = фото пользователя, игнорируй.
Дальше images идут по candidate.i: 1,2,3...

Outfit:
${JSON.stringify(compactOutfitForPrompt(outfit))}

Candidates:
${JSON.stringify(compactCandidates)}

Прими candidate, если по изображению можно уверенно сгенерировать одну чистую карточку товара:
- нужен один целевой предмет категории candidate.c;
- предмет должен быть хорошо виден по форме, цвету, крою и деталям;
- фото с человеком, моделью или манекеном допустимо, если целевой предмет можно отделить от тела и фона;
- другие элементы одежды допустимы только если они не мешают понять целевой предмет;
- фон может быть любым, потому что следующий шаг перерисует белый фон;
- если вместо товара пустое/однотонное placeholder-изображение или ошибка загрузки картинки, reject;
- reject, если предмет слишком закрыт, слишком мал, обрезан критично, смешан с несколькими похожими вещами, это не товар или невозможно понять, что продается.

Верни не больше 1 accepted на категорию/slot. Не повторяй title/url/imageUrl.

Верни только строгий JSON без Markdown:
{
  "ok": true,
  "lookTitle": "${escapeJsonString(outfit.title)}",
  "acceptedCandidates": [
    {
      "imageIndex": 1,
      "whyFits": "до 60 символов",
      "canGenerateCleanCard": true,
      "reason": "видна форма, цвет и детали вещи"
    }
  ],
  "missingItems": [
    {
      "slot": "outerwear",
      "category": "куртка",
      "reason": "все кандидаты отклонены: предмет неясен или его нельзя изолировать в чистую карточку"
    }
  ]
}

Если accepted нет, верни ok=true, acceptedCandidates=[] и missingItems по всем категориям outfit.
`.trim();
}

function createIdealProductCardGenerationPrompt(product: IdealProduct): string {
  return `
Image 0 = фото пользователя, игнорируй.
Image 1 = найденное фото товара.

Сгенерируй одну чистую карточку товара для категории "${product.category}".
Целевой товар: ${product.title}.
Описание: ${product.shortDescription}.

Требования к изображению:
- только один целевой предмет одежды или обуви;
- убрать человека, лицо, тело, руки, ноги, манекен, фон, интерьер и другие вещи;
- белый фон, фронтальный вид, предмет строго по центру, целиком в кадре;
- обязательны чистые поля: оставь 12-18% белого пространства сверху, снизу, слева и справа;
- предмет не должен касаться краев изображения и не должен быть обрезан ни сверху, ни снизу, ни по бокам;
- для брюк покажи полный пояс, всю длину штанин и низ обеих штанин; для рубашек/курток покажи воротник, оба рукава целиком, манжеты и низ изделия; для пальто/жакетов покажи весь силуэт целиком;
- если предмет высокий или широкий, уменьши масштаб, чтобы он полностью помещался в кадр с полями;
- сохранить цвет, материал, крой, принт, застежки и характерные детали;
- без текста, водяных знаков, ценников, рамок и декоративных элементов;
- не добавлять новые элементы гардероба.

Используй image_generation tool. В тексте ответа напиши только "ok".
`.trim();
}

function parseIdealOutfitChoice(text: string, outfits: IdealOutfit[]): number {
  const normalized = normalizeCommandText(text);
  const match = /^образ\s+(\d+)$/i.exec(normalized);

  if (!match) {
    return -1;
  }

  const index = Number(match[1]) - 1;

  return Number.isInteger(index) && index >= 0 && index < outfits.length
    ? index
    : -1;
}

function sanitizeIdealOutfits(
  value: unknown,
  options: IdealOutfitSanitizeOptions,
): IdealOutfit[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => sanitizeIdealOutfit(item, index, options))
    .filter((item): item is IdealOutfit => Boolean(item))
    .slice(0, 3);
}

function sanitizeIdealOutfit(
  value: unknown,
  index: number,
  options: IdealOutfitSanitizeOptions,
): IdealOutfit | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const rawItems = Array.isArray(value.items) ? value.items : [];
  const sanitizedItems = rawItems
    .map(sanitizeIdealOutfitItem)
    .filter((item): item is IdealOutfitItem => Boolean(item));
  const visibleItems = options.allowFootwear
    ? sanitizedItems
    : sanitizedItems.filter((item) => !isFootwearItem(item));
  const items = dedupeIdealOutfitItems(
    visibleItems,
  );

  if (items.length === 0) {
    return undefined;
  }

  return {
    id: readString(value.id, `look_${index + 1}`),
    title: readString(value.title, `Образ ${index + 1}`),
    summary: readString(value.summary, "Подходит по силуэту, цвету и общей подаче."),
    items,
  };
}

function sanitizeIdealOutfitItem(value: unknown): IdealOutfitItem | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const slot = readString(value.slot, "");
  const category = readString(value.category, "");
  const description = readString(value.description, "");
  const searchQuery = readString(value.searchQuery, "");

  if (!slot || !category || !description || !searchQuery) {
    return undefined;
  }

  return {
    slot,
    category,
    color: readOptionalString(value.color),
    description,
    searchQuery,
  };
}

function dedupeIdealOutfitItems(items: IdealOutfitItem[]): IdealOutfitItem[] {
  const seen = new Set<string>();
  const result: IdealOutfitItem[] = [];

  for (const item of items) {
    const key = normalizeCategoryKey(item.category || item.slot);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function isFootwearItem(item: IdealOutfitItem): boolean {
  return [item.slot, item.category, item.description, item.searchQuery].some(
    isFootwearText,
  );
}

function isFootwearText(value: string): boolean {
  return normalizeCategoryKey(value) === "shoes";
}

function idealMatchKeys(value: Pick<IdealOutfitItem, "slot" | "category">): string[] {
  return Array.from(
    new Set(
      [value.category, value.slot]
        .map((item) => normalizeCategoryKey(item))
        .filter(Boolean),
    ),
  );
}

function buildAllowedIdealMatchKeys(items: IdealOutfitItem[]): Set<string> {
  return new Set(items.flatMap(idealMatchKeys));
}

function findAllowedIdealMatchKey(
  value: Pick<IdealOutfitItem, "slot" | "category">,
  allowedKeys: Set<string>,
): string | undefined {
  return idealMatchKeys(value).find((key) => allowedKeys.has(key));
}

function selectAcceptedIdealProducts(
  candidates: IdealProduct[],
  acceptedCandidates: unknown,
  allowedItems: IdealOutfitItem[],
): IdealProduct[] {
  const accepted = sanitizeAcceptedCandidates(acceptedCandidates);
  const allowedKeys = buildAllowedIdealMatchKeys(allowedItems);
  const seenCategories = new Set<string>();
  const products: IdealProduct[] = [];

  for (const acceptedCandidate of accepted) {
    const candidate = candidates[acceptedCandidate.imageIndex - 1];

    if (!candidate) {
      continue;
    }

    const categoryKey = findAllowedIdealMatchKey(candidate, allowedKeys);

    if (!categoryKey || seenCategories.has(categoryKey)) {
      continue;
    }

    if (acceptedCandidate.canGenerateCleanCard !== true) {
      continue;
    }

    seenCategories.add(categoryKey);
    products.push({
      ...candidate,
      whyFits: acceptedCandidate.whyFits ?? candidate.whyFits,
    });
  }

  return products.slice(0, 6);
}

function selectFallbackIdealProducts(
  candidates: IdealProduct[],
  allowedItems: IdealOutfitItem[],
): IdealProduct[] {
  const allowedKeys = buildAllowedIdealMatchKeys(allowedItems);
  const seenCategories = new Set<string>();
  const products: IdealProduct[] = [];

  for (const candidate of candidates) {
    const categoryKey = findAllowedIdealMatchKey(candidate, allowedKeys);

    if (!categoryKey || seenCategories.has(categoryKey)) {
      continue;
    }

    seenCategories.add(categoryKey);
    products.push(candidate);
  }

  return products.slice(0, 6);
}

function marketProductsToIdealProducts(
  products: MarketProductRef[],
  item: IdealOutfitItem,
): IdealProduct[] {
  return products
    .map((product) => marketProductToIdealProduct(product, item))
    .filter((product): product is IdealProduct => Boolean(product))
    .slice(0, idealCandidatesPerOutfitItem);
}

function marketProductToIdealProduct(
  product: MarketProductRef,
  item: IdealOutfitItem,
): IdealProduct | undefined {
  if (!product.productUrl || !product.imageUrl) {
    return undefined;
  }

  if (!isHttpUrl(product.productUrl) || !isHttpUrl(product.imageUrl)) {
    return undefined;
  }

  const source = marketplaceName(product.provider);
  const brandPrefix = product.brand ? `${product.brand}: ` : "";
  const title = truncateText(`${brandPrefix}${product.title}`, 120);
  const descriptionParts = [
    item.color ? `${item.color} ${item.category}` : item.category,
    product.category,
  ].filter(Boolean);

  return {
    slot: item.slot,
    category: item.category,
    title,
    shortDescription: truncateText(
      descriptionParts.join(", ") || item.description,
      80,
    ),
    productUrl: product.productUrl,
    imageUrl: product.imageUrl,
    price: product.price ? formatMarketPrice(product.price) : undefined,
    source,
    whyFits: truncateText(item.description, 60),
  };
}

function sanitizeAcceptedCandidates(value: unknown): IdealAcceptedCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(sanitizeAcceptedCandidate)
    .filter((item): item is IdealAcceptedCandidate => Boolean(item));
}

function sanitizeAcceptedCandidate(
  value: unknown,
): IdealAcceptedCandidate | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const imageIndex = readPositiveInteger(value.imageIndex);

  if (!imageIndex || value.canGenerateCleanCard !== true) {
    return undefined;
  }

  return {
    imageIndex,
    whyFits: readOptionalString(value.whyFits),
    canGenerateCleanCard: true,
    reason: readOptionalString(value.reason),
  };
}

function sanitizeIdealProducts(
  value: unknown,
  options: {
    allowedItems: IdealOutfitItem[];
    requireCleanCardReady: boolean;
    allowMultiplePerCategory: boolean;
    maxProducts: number;
  },
): IdealProduct[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenCategories = new Set<string>();
  const seenUrls = new Set<string>();
  const allowedKeys = buildAllowedIdealMatchKeys(options.allowedItems);
  const products: IdealProduct[] = [];

  for (const raw of value) {
    const product = sanitizeIdealProduct(raw, options.requireCleanCardReady);

    if (!product) {
      continue;
    }

    const categoryKey = findAllowedIdealMatchKey(product, allowedKeys);
    const urlKey = product.productUrl.toLowerCase();

    if (
      !categoryKey ||
      (!options.allowMultiplePerCategory && seenCategories.has(categoryKey)) ||
      seenUrls.has(urlKey)
    ) {
      continue;
    }

    seenCategories.add(categoryKey);
    seenUrls.add(urlKey);
    products.push(product);
  }

  return products.slice(0, options.maxProducts);
}

function sanitizeIdealProduct(
  value: unknown,
  requireCleanCardReady: boolean,
): IdealProduct | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const slot = readString(value.slot, "");
  const category = readString(value.category, "");
  const title = readString(value.title, "");
  const shortDescription = readString(value.shortDescription, "");
  const productUrl = readString(value.productUrl, "");
  const imageUrl = readString(value.imageUrl, "");

  if (
    !slot ||
    !category ||
    !title ||
    !shortDescription ||
    !isHttpUrl(productUrl) ||
    !isHttpUrl(imageUrl)
  ) {
    return undefined;
  }

  if (requireCleanCardReady && value.canGenerateCleanCard !== true) {
    return undefined;
  }

  const originalImageUrl = readOptionalString(value.originalImageUrl);

  return {
    slot,
    category,
    title,
    shortDescription,
    productUrl,
    imageUrl,
    price: readOptionalString(value.price),
    source: readOptionalString(value.source),
    whyFits: readOptionalString(value.whyFits),
    ...(originalImageUrl && isHttpUrl(originalImageUrl)
      ? { originalImageUrl }
      : {}),
  };
}

function sanitizeIdealMissingItems(value: unknown): IdealMissingItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(sanitizeIdealMissingItem)
    .filter((item): item is IdealMissingItem => Boolean(item));
}

function sanitizeIdealMissingItem(value: unknown): IdealMissingItem | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const slot = readString(value.slot, "");
  const category = readString(value.category, "");
  const reason = readString(value.reason, "");

  if (!slot || !category || !reason) {
    return undefined;
  }

  return {
    slot,
    category,
    reason,
  };
}

function mergeMissingItems(...groups: IdealMissingItem[][]): IdealMissingItem[] {
  const seen = new Set<string>();
  const result: IdealMissingItem[] = [];

  for (const item of groups.flat()) {
    const key = normalizeCategoryKey(item.category || item.slot);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function buildMissingItemsFromOutfit(
  outfit: IdealOutfit,
  products: IdealProduct[],
): IdealMissingItem[] {
  const productKeys = new Set(products.flatMap(idealMatchKeys));

  return outfit.items
    .filter(
      (item) => !idealMatchKeys(item).some((key) => productKeys.has(key)),
    )
    .map((item) => ({
      slot: item.slot,
      category: item.category,
      reason: "Не найден товар, который можно надежно превратить в чистую карточку на белом фоне",
    }));
}

function formatIdealOutfitOptions(
  summary: string | undefined,
  outfits: IdealOutfit[],
  options: { footwearVisible: boolean },
): string {
  const lines = [
    summary ?? "Я собрал несколько вариантов, которые должны хорошо лечь на вашу внешность.",
    options.footwearVisible
      ? undefined
      : "Обувь не добавляю в подборку, потому что ботинки или стопы не видны на фото.",
    "",
    "Выберите образ:",
  ].filter((line): line is string => line !== undefined);

  for (const [index, outfit] of outfits.entries()) {
    lines.push("");
    lines.push(`**Образ ${index + 1}: ${outfit.title}**`);
    lines.push(outfit.summary);
    lines.push(
      outfit.items
        .map((item) => `${item.category}: ${item.description}`)
        .join("\n"),
    );
  }

  return lines.join("\n");
}

function formatProductCaption(product: IdealProduct): string {
  return [
    `**${product.title}**`,
    product.shortDescription,
    product.price ? `Цена: ${product.price}` : undefined,
    product.source ? `Магазин: ${product.source}` : undefined,
    product.whyFits ? `Почему подходит: ${product.whyFits}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function marketplaceName(provider: MarketProductRef["provider"]): string {
  if (provider === "ozon") {
    return "Ozon";
  }

  if (provider === "wildberries") {
    return "Wildberries";
  }

  return "AliExpress";
}

function formatMarketPrice(price: NonNullable<MarketProductRef["price"]>): string {
  if (!price.currency) {
    return String(price.amount);
  }

  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: price.currency,
      maximumFractionDigits: 2,
    }).format(price.amount);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

function formatCandidateCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "кандидат"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "кандидата"
        : "кандидатов";

  return `${count} ${word}`;
}

function formatIdealProductProgress(params: {
  lookTitle: string;
  search: string;
  validation: string;
  generation: string;
  progress?: number;
  note?: string;
}): string {
  const progress = clampProgress(
    params.progress ?? inferIdealProductProgress(params),
  );

  return [
    `Подбор товаров для **${params.lookTitle}**`,
    "",
    `Прогресс: ${formatTextProgressBar(progress)}`,
    "",
    `Поиск товаров: ${params.search}`,
    `Проверка фото: ${params.validation}`,
    `Генерация карточек: ${params.generation}`,
    params.note ? "" : undefined,
    params.note,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function inferIdealProductProgress(params: {
  search: string;
  validation: string;
  generation: string;
}): number {
  const search = params.search.toLowerCase();
  const validation = params.validation.toLowerCase();
  const generation = params.generation.toLowerCase();

  if (
    search.includes("ошибка") ||
    validation.includes("ошибка") ||
    generation.includes("ошибка")
  ) {
    return 100;
  }

  const generatedMatch = /готово\s+(\d+)\s*\/\s*(\d+)/i.exec(
    params.generation,
  );

  if (generatedMatch) {
    const done = Number(generatedMatch[1]);
    const total = Number(generatedMatch[2]);

    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
      return 74 + Math.round((Math.min(done, total) / total) * 22);
    }
  }

  if (generation.includes("готово")) {
    return 100;
  }

  if (generation.includes("выполня")) {
    return 78;
  }

  if (generation.includes("очеред")) {
    return 70;
  }

  if (generation.includes("ожида")) {
    if (validation.includes("готово")) {
      return 66;
    }

    if (validation.includes("выполня")) {
      return 56;
    }

    if (validation.includes("очеред")) {
      return 50;
    }

    if (validation.includes("создаю")) {
      return 44;
    }
  }

  if (validation.includes("готово")) {
    return 66;
  }

  if (search.includes("готово")) {
    return 34;
  }

  if (search.includes("выполня")) {
    return 22;
  }

  if (search.includes("очеред")) {
    return 14;
  }

  if (search.includes("создаю")) {
    return 6;
  }

  return 3;
}

function formatTextProgressBar(progress: number): string {
  const total = 20;
  const filled = Math.round((clampProgress(progress) / 100) * total);

  return `[${"#".repeat(filled)}${"-".repeat(total - filled)}] ${clampProgress(progress)}%`;
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function formatProductSelectionIntro(
  lookTitle: string,
  products: IdealProduct[],
  missingItems: IdealMissingItem[],
): string {
  const lines = [
    `Подбор товаров для **${lookTitle}**`,
    "",
    `Прогресс: ${formatTextProgressBar(100)}`,
    "",
    `Подборка для образа **${lookTitle}**.`,
    `Показываю чистые карточки товаров на белом фоне. Исходные страницы искались в основном по РФ, рублям и доставке в Москву, когда это было видно.`,
    `Подготовлено товаров: ${products.length}.`,
  ];

  if (missingItems.length) {
    lines.push("");
    lines.push("Не удалось подобрать качественную карточку для:");
    lines.push(...formatMissingItems(missingItems));
  }

  return lines.join("\n");
}

function formatMissingProductsMessage(
  outfit: IdealOutfit,
  products: IdealProduct[],
  missingItems: IdealMissingItem[],
  fallback: string,
): string {
  const mergedMissingItems = mergeMissingItems(
    missingItems,
    buildMissingItemsFromOutfit(outfit, products),
  );
  const lines = [fallback];

  if (mergedMissingItems.length) {
    lines.push("");
    lines.push("Проблемные элементы:");
    lines.push(...formatMissingItems(mergedMissingItems));
  }

  return lines.join("\n");
}

function formatMissingItems(missingItems: IdealMissingItem[]): string[] {
  return missingItems.map(
    (item) => `- ${item.category}: ${item.reason}`,
  );
}

function parseJsonFromOpenAiMessage<T>(message: string): T | undefined {
  const text = stripWorkerOpenAiPrefix(message);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? extractJsonObjectText(text);

  if (!candidate) {
    return undefined;
  }

  try {
    return JSON.parse(candidate) as T;
  } catch (error) {
    logger.warn("Failed to parse OpenAI JSON response", {
      error,
      responseStart: candidate.slice(0, 300),
    });
    return undefined;
  }
}

function stripWorkerOpenAiPrefix(message: string): string {
  return message
    .replace(/^Ответ от сервера\. Провайдер: OpenAI\.\s*/i, "")
    .trim();
}

function isWorkerFailureMessage(message: string): boolean {
  const text = stripWorkerOpenAiPrefix(message);

  return (
    text.startsWith("Не удалось выполнить подбор образа или товаров.") ||
    text.startsWith("Сервер временно уперся в лимит OpenAI.")
  );
}

function extractJsonObjectText(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return undefined;
  }

  return value.slice(start, end + 1);
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

function storageObjectAccessUrl(
  objectBaseUrl: string,
  key: string,
  accessToken: string,
): string {
  const url = new URL(storageObjectUrl(objectBaseUrl, key));
  url.searchParams.set("accessToken", accessToken);

  return url.toString();
}

function createIdealProductCardCacheRef(
  clientId: string,
  productUrl: string,
): IdealProductCardCacheRef {
  const canonicalProductUrl = canonicalProductUrlForCache(productUrl);
  const hash = createHash("sha256")
    .update(canonicalProductUrl)
    .digest("hex");
  const keyPrefix = `clients/${clientId}/product-card-cache/${hash.slice(0, 2)}`;

  return {
    keyPrefix,
    imageKey: `${keyPrefix}/${hash}.png`,
    metadataKey: `${keyPrefix}/${hash}.json`,
    canonicalProductUrl,
    catalogCacheKey: `product-card:${hash}`,
  };
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

function sanitizeStorageFilename(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, "-") || "telegram-photo.jpg"
  );
}

function telegramPhotoFilenameFromUrl(photoUrl: string): string {
  try {
    return sanitizeStorageFilename(new URL(photoUrl).pathname);
  } catch {
    return sanitizeStorageFilename(photoUrl);
  }
}

function redactUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";

    return url.toString();
  } catch {
    return value.split("?")[0] ?? value;
  }
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

function extensionFromContentType(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();

  if (normalized === "image/png") {
    return ".png";
  }

  if (normalized === "image/webp") {
    return ".webp";
  }

  if (normalized === "image/gif") {
    return ".gif";
  }

  return ".jpg";
}

function ensureFilenameExtension(filename: string, contentType: string): string {
  if (/\.[a-z0-9]{2,5}$/i.test(filename)) {
    return filename;
  }

  return `${filename}${extensionFromContentType(contentType)}`;
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readTelegramMessageId(value: unknown): number | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  return readPositiveInteger(value.message_id);
}

function normalizeCategoryKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");

  const synonymGroups: Array<[string, RegExp]> = [
    ["top", /^(top|верх|верхний слой)$/],
    ["bottom", /^(bottom|низ)$/],
    ["layer", /^(layer|слой|средний слой)$/],
    ["outerwear", /^(outerwear|верхняя одежда)$/],
    ["vest", /(жилет|безрукавк|vest|bodywarmer|sleeveless jacket)/],
    ["polo", /(поло|\bpolo\b)/],
    ["cardigan", /(кардиган|cardigan)/],
    ["sweater", /(свитер|джемпер|пуловер|sweater|jumper|pullover)/],
    ["hoodie", /(худи|hoodie|толстовк|свитшот|sweatshirt)/],
    ["jacket", /(рубашк[а -]*жакет|овершерт|overshirt|куртк|жакет|бомбер|пиджак|блейзер|ветровк|jacket|blazer|bomber)/],
    ["shirt", /(рубаш|сорочк|\bshirt\b)/],
    ["tshirt", /(футболк|лонгслив|t-?shirt|\btee\b|longsleeve)/],
    ["coat", /(пальто|тренч|coat|trench)/],
    ["pants", /(брюк|джинс|штаны|чинос|карго|pants|trousers|jeans|chinos|cargo)/],
    ["shorts", /(шорт|shorts)/],
    ["skirt", /(юбк|skirt)/],
    ["dress", /(плать|dress)/],
    ["shoes", /(кроссов|кеды|ботин|сапог|туфл|лофер|обув|сандал|босонож|мокасин|sneakers|shoes|boots|loafers|footwear|sandals|moccasins)/],
    ["bag", /(сумк|рюкзак|bag|backpack)/],
    ["accessory", /(ремень|очки|шапк|кепк|шарф|перчат|belt|glasses|cap|scarf|accessor)/],
  ];

  for (const [key, pattern] of synonymGroups) {
    if (pattern.test(normalized)) {
      return key;
    }
  }

  return normalized;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeJsonString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
