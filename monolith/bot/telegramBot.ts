import { sleep } from "../utils/http.js";
import { createLogger } from ".././utils/logger.js";
import type { MonolithConfig } from "../config.js";
import { MonolithCatalog } from "../catalog/catalog.js";
import type {
  GarmentCatalogItem,
  IdealOutfitOption,
  IdealOutfitPlan,
  ImageData,
  OutfitCandidateGroup,
  OutfitCategoryRequest,
  OutfitSelection,
  OutfitSelectionItem,
  StoredImage,
} from "../types.js";
import { OpenAiVisionService } from "../providers/openaiVision.js";
import type { TryOnProvider } from "../providers/tryOn.js";
import { LocalFileStorage } from "../storage/localFileStorage.js";
import { fetchWithTimeout, readResponseBuffer } from "../utils/http.js";

const logger = createLogger("monolith");
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
  message_id?: number;
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

type ChatSession =
  | {
      mode: "awaiting-appearance-photo";
    }
  | {
      mode: "awaiting-ideal-photo";
    }
  | {
      mode: "awaiting-ideal-style";
      person: StoredImage;
      options: IdealOutfitOption[];
    }
  | {
      mode: "awaiting-tryon-person-photo";
    }
  | {
      mode: "awaiting-tryon-garment-photo";
      person: StoredImage;
    };

type ProcessingFlow = "appearance" | "ideal" | "tryon" | "catalog";

interface ProcessingState {
  flow: ProcessingFlow;
  startedAt: number;
}

const appearanceAnalysisButtonText = "Анализ внешности";
const idealOutfitButtonText = "Идеальный образ";
const manualTryOnButtonText = "Ручная примерка";
const catalogRefreshButtonText = "Обновить каталог";
const legacyAppearanceAnalysisButtonText = "Разбор внешности";
const legacyTryOnButtonText = "Примерка TryOn";
const cancelButtonText = "Отмена";

export class TelegramMonolithBot {
  private updateOffset = 0;
  private readonly sessions = new Map<string, ChatSession>();
  private readonly processing = new Map<string, ProcessingState>();

  constructor(
    private readonly config: MonolithConfig,
    private readonly storage: LocalFileStorage,
    private readonly openai: OpenAiVisionService,
    private readonly tryOn: TryOnProvider,
    private readonly catalog: MonolithCatalog,
  ) {}

  async startPolling(): Promise<void> {
    logger.info("Monolith Telegram polling started", {
      pollingTimeoutSeconds: this.config.pollingTimeoutSeconds,
      storageRoot: this.config.storageRoot,
      tryOnProvider: this.tryOn.name,
      catalogEnabled: this.config.catalog.enabled,
      catalogCachePath: this.config.catalog.cachePath,
    });

    while (true) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          this.updateOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        logger.error("Monolith polling error", { error });
        await sleep(5_000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim() ?? message?.caption?.trim();

    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);
    const processing = this.processing.get(chatId);

    if (processing) {
      logger.info("Telegram update blocked while monolith flow is running", {
        chatId,
        flow: processing.flow,
        text,
        hasPhoto: Boolean(message.photo?.length),
      });
      await this.sendMessage(
        chatId,
        `Сейчас уже выполняю **${describeProcessingFlow(processing.flow)}**. Дождитесь результата, чтобы не сбить шаги бота.`,
        processingMarkup(),
      );
      return;
    }

    const session = this.sessions.get(chatId);

    if (session) {
      if (text && isCancelCommand(text)) {
        this.sessions.delete(chatId);
        await this.sendMessage(
          chatId,
          "Ок, остановились. Выберите, что сделать дальше.",
          mainMenuMarkup(),
        );
        return;
      }

      if (text && isInterruptingCommand(text)) {
        await this.sendActiveSessionMessage(chatId, session);
        return;
      }

      await this.handleSessionStep(message, session);
      return;
    }

    if (text === "/start") {
      await this.setupCommands();
      await this.sendStartMessage(chatId);
      return;
    }

    if (text && isCancelCommand(text)) {
      await this.sendMessage(
        chatId,
        "Активного процесса нет. Выберите сценарий кнопкой ниже.",
        mainMenuMarkup(),
      );
      return;
    }

    if (text && isAppearanceAnalysisCommand(text)) {
      await this.startAppearanceAnalysis(chatId);
      return;
    }

    if (text && isIdealOutfitCommand(text)) {
      await this.startIdealOutfit(chatId);
      return;
    }

    if (text && isTryOnCommand(text)) {
      await this.startTryOn(chatId);
      return;
    }

    if (text && isCatalogCommand(text)) {
      await this.startCatalogRefresh(chatId);
      return;
    }

    if (!text && message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Сначала выберите сценарий: анализ внешности, идеальный образ или ручная примерка.",
        mainMenuMarkup(),
      );
      return;
    }

    await this.sendStartMessage(chatId);
  }

  private async handleSessionStep(
    message: TelegramMessage,
    session: ChatSession,
  ): Promise<void> {
    if (session.mode === "awaiting-appearance-photo") {
      await this.handleAppearancePhotoStep(message);
      return;
    }

    if (session.mode === "awaiting-ideal-photo") {
      await this.handleIdealOutfitPhotoStep(message);
      return;
    }

    if (session.mode === "awaiting-ideal-style") {
      await this.handleIdealStyleSelectionStep(message, session);
      return;
    }

    if (session.mode === "awaiting-tryon-person-photo") {
      await this.handleTryOnPersonPhotoStep(message);
      return;
    }

    await this.handleTryOnGarmentPhotoStep(message, session.person);
  }

  private sendStartMessage(chatId: string): Promise<unknown> {
    return this.sendMessage(
      chatId,
      [
        "Привет! Это отдельный MVP-монолит TryOnService: один Telegram-бот сам хранит фото, читает каталог одежды, вызывает ChatGPT API и отправляет выбранные вещи в TryOn API.",
        "",
        "**Анализ внешности**: пришлите фото с видимым лицом, я дам компактный разбор.",
        "**Идеальный образ**: пришлите фото в полный рост или по колено, я выберу стиль, найду вещи в локальном каталоге и сделаю примерку.",
        "**Ручная примерка**: пришлите фото человека и отдельное фото вещи.",
        "",
        "Выберите сценарий кнопкой ниже.",
      ].join("\n"),
      mainMenuMarkup(),
    );
  }

  private startAppearanceAnalysis(chatId: string): Promise<unknown> {
    this.sessions.set(chatId, {
      mode: "awaiting-appearance-photo",
    });

    return this.sendMessage(
      chatId,
      "Отправьте изображение с вашим лицом.",
      cancelMarkup(),
    );
  }

  private async handleAppearancePhotoStep(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);

    if (!message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Пришлите фото реального человека с хорошо видимым лицом или нажмите «Отмена».",
        cancelMarkup(),
      );
      return;
    }

    this.sessions.delete(chatId);
    this.processing.set(chatId, { flow: "appearance", startedAt: Date.now() });
    await this.sendMessage(
      chatId,
      "Фото принято. Делаю разбор внешности через ChatGPT API.",
      processingMarkup(),
    );

    void this.runAppearanceAnalysis(message).catch((error) => {
      logger.error("Appearance analysis background task crashed", {
        chatId,
        error,
      });
    });
  }

  private async runAppearanceAnalysis(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);

    try {
      const image = await this.downloadTelegramPhoto(message);
      const stored = await this.storage.saveImage("telegram-input", image, {
        chatId,
        flow: "appearance",
        username: message.from?.username,
      });
      logger.info("Appearance photo saved", {
        chatId,
        path: stored.relativePath,
        sizeBytes: stored.sizeBytes,
        contentType: stored.contentType,
      });
      const result = await this.openai.analyzeAppearance(image);

      await this.sendMessage(chatId, result, mainMenuMarkup());
    } catch (error) {
      logger.error("Appearance analysis failed", {
        chatId,
        error,
      });
      await this.sendMessage(
        chatId,
        friendlyErrorMessage(error, "Не удалось сделать разбор внешности. Попробуйте еще раз."),
        mainMenuMarkup(),
      );
    } finally {
      this.processing.delete(chatId);
    }
  }

  private startIdealOutfit(chatId: string): Promise<unknown> {
    this.sessions.set(chatId, {
      mode: "awaiting-ideal-photo",
    });

    return this.sendMessage(
      chatId,
      "Пришлите фото в полный рост или хотя бы по колено. Обувь может быть не видна, тогда я просто не буду подбирать обувь.",
      cancelMarkup(),
    );
  }

  private async handleIdealOutfitPhotoStep(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);

    if (!message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Нужно фото человека в полный рост или по колено. Пришлите изображение или нажмите «Отмена».",
        cancelMarkup(),
      );
      return;
    }

    this.sessions.delete(chatId);
    this.processing.set(chatId, { flow: "ideal", startedAt: Date.now() });
    const status = await this.sendStatusMessage(
      chatId,
      renderIdealProgress("готовлю фото", 8),
    );

    void this.runIdealOutfit(message, status?.message_id).catch((error) => {
      logger.error("Ideal outfit background task crashed", {
        chatId,
        error,
      });
    });
  }

  private async runIdealOutfit(
    message: TelegramMessage,
    statusMessageId?: number,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    try {
      const image = await this.downloadTelegramPhoto(message);
      const stored = await this.storage.saveImage("telegram-input", image, {
        chatId,
        flow: "ideal",
        username: message.from?.username,
      });

      logger.info("Ideal outfit photo saved", {
        chatId,
        path: stored.relativePath,
        sizeBytes: stored.sizeBytes,
      });
      await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("читаю каталог", 18));

      const items = await this.catalog.ensureReady();
      const catalogHints = await this.catalog.categoryTagHints();

      if (!this.config.catalog.enabled || items.length === 0 || catalogHints.length === 0) {
        throw new Error("Monolith catalog is empty");
      }

      await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("анализирую фото и собираю варианты", 44));
      const plan = await this.openai.planIdealOutfit(image, catalogHints);
      const options = normalizeIdealStyleOptions(plan);

      if (!plan.accepted || options.length === 0) {
        this.sessions.set(chatId, { mode: "awaiting-ideal-photo" });
        await this.updateStatusMessage(
          chatId,
          statusMessageId,
          plan.rejectionMessage ??
            "Фото не подходит для подбора образа. Пришлите фото в полный рост или хотя бы по колено.",
          cancelMarkup(),
        );
        return;
      }

      this.sessions.set(chatId, {
        mode: "awaiting-ideal-style",
        person: stored,
        options,
      });
      await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("варианты готовы", 100));
      await this.sendMessage(
        chatId,
        renderIdealStyleOptionsMessage(options),
        idealStyleOptionsMarkup(options),
      );
    } catch (error) {
      logger.error("Ideal outfit plan failed", {
        chatId,
        provider: this.tryOn.name,
        error,
      });
      await this.updateStatusMessage(
        chatId,
        statusMessageId,
        friendlyErrorMessage(error, "Не удалось подготовить варианты образа. Попробуйте другое фото или обновите каталог."),
        mainMenuMarkup(),
      );
    } finally {
      this.processing.delete(chatId);
    }
  }

  private async handleIdealStyleSelectionStep(
    message: TelegramMessage,
    session: Extract<ChatSession, { mode: "awaiting-ideal-style" }>,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? message.caption?.trim();
    const selected = text ? selectIdealOutfitOption(text, session.options) : undefined;

    if (!selected) {
      await this.sendMessage(
        chatId,
        "Выберите один из трех вариантов кнопкой ниже или нажмите «Отмена».",
        idealStyleOptionsMarkup(session.options),
      );
      return;
    }

    this.sessions.delete(chatId);
    this.processing.set(chatId, { flow: "ideal", startedAt: Date.now() });
    const status = await this.sendStatusMessage(
      chatId,
      renderIdealProgress(`выбран стиль: ${selected.styleName ?? "идеальный образ"}`, 8),
    );

    void this.runSelectedIdealOutfit(chatId, session.person, selected, status?.message_id).catch((error) => {
      logger.error("Ideal outfit selected style background task crashed", {
        chatId,
        error,
      });
    });
  }

  private async runSelectedIdealOutfit(
    chatId: string,
    person: StoredImage,
    option: IdealOutfitOption,
    statusMessageId?: number,
  ): Promise<void> {
    try {
      const image = await this.storage.readImage(person);

      await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("читаю каталог", 18));
      const items = await this.catalog.ensureReady();

      if (!this.config.catalog.enabled || items.length === 0) {
        throw new Error("Monolith catalog is empty");
      }

      await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("подбираю вещи", 46));
      const groups = await this.buildCandidateGroups(option.categories);
      const missing = groups.filter((group) => group.candidates.length === 0);
      const usableGroups = groups.filter((group) => group.candidates.length > 0);

      if (usableGroups.length === 0) {
        throw new Error("Monolith catalog did not contain candidates for selected outfit categories");
      }

      const selection = buildLocalOutfitSelection(option, usableGroups);
      const selected = uniqueSelectedCatalogItems(selection.items, usableGroups);

      if (selected.length === 0) {
        throw new Error("Local catalog scoring did not select catalog items");
      }

      await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("готовлю изображения", 70));
      const garmentImages = await Promise.all(
        selected.map((entry) => this.catalog.getImage(entry.item)),
      );

      await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("делаю примерку", 86));
      const result = await this.tryOn.run({ person: image, garments: garmentImages });

      if (result.image) {
        const resultStored = await this.storage.saveImage("tryon-result", result.image, {
          chatId,
          flow: "ideal",
          provider: result.provider,
          styleName: selection.styleName,
        });
        logger.info("Ideal outfit TryOn result saved", {
          chatId,
          provider: result.provider,
          path: resultStored.relativePath,
          sizeBytes: resultStored.sizeBytes,
          selectedItems: selected.map((entry) => entry.item.id),
        });
        await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("готово", 100));
        await this.sendPhotoBuffer(
          chatId,
          result.image,
          [
            `**${selection.styleName}**`,
            selection.summary,
            "",
            result.message,
            `Файл сохранен локально: ${resultStored.relativePath}`,
          ].join("\n"),
          mainMenuMarkup(),
        );
      } else {
        await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("готово", 100));
        await this.sendMessage(
          chatId,
          `**${selection.styleName}**\n${selection.summary}\n\n${result.message}`,
          mainMenuMarkup(),
        );
      }

      for (const entry of selected) {
        await this.sendGarmentCard(chatId, entry.item, entry.reason);
      }

      if (missing.length > 0) {
        await this.sendMessage(
          chatId,
          [
            "Часть категорий не нашлась в локальном каталоге:",
            ...missing.map((group) => `- ${group.request.category}: ${group.request.query}`),
          ].join("\n"),
          mainMenuMarkup(),
        );
      }
    } catch (error) {
      logger.error("Ideal outfit failed", {
        chatId,
        provider: this.tryOn.name,
        error,
      });
      await this.updateStatusMessage(
        chatId,
        statusMessageId,
        friendlyErrorMessage(error, "Не удалось собрать идеальный образ. Попробуйте другой вариант стиля, другое фото или обновите каталог."),
        mainMenuMarkup(),
      );
    } finally {
      this.processing.delete(chatId);
    }
  }
  private async buildCandidateGroups(
    requests: OutfitCategoryRequest[],
  ): Promise<OutfitCandidateGroup[]> {
    const groups: OutfitCandidateGroup[] = [];

    for (const request of requests.slice(0, 3)) {
      const candidates = await this.catalog.findCandidates(
        request,
        this.config.catalog.candidatesPerCategory,
      );
      groups.push({ request, candidates });
    }

    return groups;
  }

  private async sendGarmentCard(
    chatId: string,
    item: GarmentCatalogItem,
    reason?: string,
  ): Promise<void> {
    const caption = [
      `**${item.category}: ${item.title}**`,
      item.brand ? `Бренд: ${item.brand}` : undefined,
      formatPrice(item),
      `Магазин: ${item.store}`,
      reason ? `Почему подходит: ${reason}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const markup = productLinkMarkup(item.productUrl);

    try {
      await this.callApi("sendPhoto", {
        chat_id: chatId,
        photo: item.imageUrl,
        caption: markdownToTelegramHtml(shortenTelegramCaption(caption)),
        parse_mode: "HTML",
        reply_markup: markup,
      });
      return;
    } catch (error) {
      logger.warn("Telegram could not send catalog image by URL", {
        chatId,
        itemId: item.id,
        error,
      });
    }

    try {
      const image = await this.catalog.getImage(item);
      await this.sendPhotoBuffer(chatId, image, caption, markup);
      return;
    } catch (error) {
      logger.warn("Telegram could not send catalog image from buffer", {
        chatId,
        itemId: item.id,
        error,
      });
    }

    await this.sendMessage(
      chatId,
      `${caption}\n[Перейти к товару](${item.productUrl})`,
      mainMenuMarkup(),
    );
  }

  private startTryOn(chatId: string): Promise<unknown> {
    this.sessions.set(chatId, {
      mode: "awaiting-tryon-person-photo",
    });

    return this.sendMessage(
      chatId,
      "Пришлите фото человека для примерки. Лучше полный рост или по колено, с хорошим светом.",
      cancelMarkup(),
    );
  }

  private async handleTryOnPersonPhotoStep(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);

    if (!message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Нужно фото человека. Пришлите изображение или нажмите «Отмена».",
        cancelMarkup(),
      );
      return;
    }

    try {
      const image = await this.downloadTelegramPhoto(message);
      const stored = await this.storage.saveImage("telegram-input", image, {
        chatId,
        flow: "tryon",
        role: "person",
        username: message.from?.username,
      });

      this.sessions.set(chatId, {
        mode: "awaiting-tryon-garment-photo",
        person: stored,
      });
      await this.sendMessage(
        chatId,
        "Фото человека сохранил. Теперь пришлите фото вещи для примерки, желательно фронтально на чистом фоне.",
        cancelMarkup(),
      );
    } catch (error) {
      logger.error("TryOn person photo save failed", {
        chatId,
        error,
      });
      await this.sendMessage(
        chatId,
        friendlyErrorMessage(error, "Не удалось сохранить фото. Попробуйте отправить его еще раз."),
        cancelMarkup(),
      );
    }
  }

  private async handleTryOnGarmentPhotoStep(
    message: TelegramMessage,
    person: StoredImage,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    if (!message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Теперь нужно фото вещи. Пришлите изображение одежды или нажмите «Отмена».",
        cancelMarkup(),
      );
      return;
    }

    this.sessions.delete(chatId);
    this.processing.set(chatId, { flow: "tryon", startedAt: Date.now() });
    await this.sendMessage(
      chatId,
      `Фото вещи принято. Отправляю пару в TryOn provider: **${this.tryOn.name}**.`,
      processingMarkup(),
    );

    void this.runTryOn(message, person).catch((error) => {
      logger.error("TryOn background task crashed", {
        chatId,
        error,
      });
    });
  }

  private async runTryOn(
    message: TelegramMessage,
    personStored: StoredImage,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    try {
      const [person, garment] = await Promise.all([
        this.storage.readImage(personStored),
        this.downloadTelegramPhoto(message),
      ]);
      const garmentStored = await this.storage.saveImage("telegram-input", garment, {
        chatId,
        flow: "tryon",
        role: "garment",
        username: message.from?.username,
      });
      logger.info("TryOn input photos ready", {
        chatId,
        personPath: personStored.relativePath,
        garmentPath: garmentStored.relativePath,
        provider: this.tryOn.name,
      });
      const result = await this.tryOn.run({ person, garments: [garment] });

      if (result.image) {
        const resultStored = await this.storage.saveImage("tryon-result", result.image, {
          chatId,
          flow: "tryon",
          provider: result.provider,
        });
        logger.info("TryOn result saved", {
          chatId,
          provider: result.provider,
          path: resultStored.relativePath,
          sizeBytes: resultStored.sizeBytes,
        });
        await this.sendPhotoBuffer(
          chatId,
          result.image,
          `${result.message}\n\nФайл сохранен локально: ${resultStored.relativePath}`,
          mainMenuMarkup(),
        );
      } else {
        await this.sendMessage(chatId, result.message, mainMenuMarkup());
      }
    } catch (error) {
      logger.error("TryOn failed", {
        chatId,
        provider: this.tryOn.name,
        error,
      });
      await this.sendMessage(
        chatId,
        friendlyErrorMessage(error, "Не удалось выполнить примерку. Попробуйте еще раз."),
        mainMenuMarkup(),
      );
    } finally {
      this.processing.delete(chatId);
    }
  }

  private async startCatalogRefresh(chatId: string): Promise<void> {
    this.processing.set(chatId, { flow: "catalog", startedAt: Date.now() });
    const status = await this.sendStatusMessage(
      chatId,
      "Обновляю локальный каталог одежды. Это может занять немного времени.",
    );

    void this.runCatalogRefresh(chatId, status?.message_id).catch((error) => {
      logger.error("Catalog refresh background task crashed", {
        chatId,
        error,
      });
    });
  }

  private async runCatalogRefresh(
    chatId: string,
    statusMessageId?: number,
  ): Promise<void> {
    try {
      const items = await this.catalog.refresh();
      const categories = await this.catalog.categories();

      await this.updateStatusMessage(
        chatId,
        statusMessageId,
        [
          `Каталог обновлен. Товаров: **${items.length}**.`,
          `Категории: ${categories.slice(0, 18).join(", ") || "нет"}.`,
          `Кэш: ${this.config.catalog.cachePath}`,
        ].join("\n"),
        mainMenuMarkup(),
      );
    } catch (error) {
      logger.error("Catalog refresh failed", { chatId, error });
      await this.updateStatusMessage(
        chatId,
        statusMessageId,
        friendlyErrorMessage(error, "Не удалось обновить каталог."),
        mainMenuMarkup(),
      );
    } finally {
      this.processing.delete(chatId);
    }
  }

  private sendActiveSessionMessage(
    chatId: string,
    session: ChatSession,
  ): Promise<unknown> {
    switch (session.mode) {
      case "awaiting-appearance-photo":
        return this.sendMessage(
          chatId,
          "Сейчас открыт анализ внешности. Пришлите фото с лицом или нажмите «Отмена».",
          cancelMarkup(),
        );
      case "awaiting-ideal-photo":
        return this.sendMessage(
          chatId,
          "Сейчас открыт идеальный образ. Пришлите фото в полный рост или по колено, либо нажмите «Отмена».",
          cancelMarkup(),
        );
      case "awaiting-ideal-style":
        return this.sendMessage(
          chatId,
          "Сейчас нужно выбрать один из трех вариантов стиля или нажать «Отмена».",
          idealStyleOptionsMarkup(session.options),
        );
      case "awaiting-tryon-person-photo":
        return this.sendMessage(
          chatId,
          "Сейчас открыта ручная примерка. Пришлите фото человека или нажмите «Отмена».",
          cancelMarkup(),
        );
      case "awaiting-tryon-garment-photo":
        return this.sendMessage(
          chatId,
          "Сейчас открыта ручная примерка. Фото человека уже есть, пришлите фото вещи или нажмите «Отмена».",
          cancelMarkup(),
        );
    }
  }
  private async setupCommands(): Promise<unknown> {
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
        description: "Идеальный образ из каталога",
      },
      {
        command: "tryon",
        description: "Ручная примерка одежды",
      },
      {
        command: "catalog",
        description: "Обновить локальный каталог",
      },
      {
        command: "cancel",
        description: "Отменить текущий сценарий",
      },
    ];

    return this.callApi("setMyCommands", { commands });
  }

  private getUpdates(): Promise<TelegramUpdate[]> {
    return this.callApi<TelegramUpdate[]>("getUpdates", {
      offset: this.updateOffset,
      timeout: this.config.pollingTimeoutSeconds,
      allowed_updates: ["message"],
    });
  }

  private sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<unknown> {
    return this.sendFormattedMessage(chatId, text, replyMarkup);
  }

  private async sendStatusMessage(
    chatId: string,
    text: string,
    replyMarkup: TelegramReplyMarkup = processingMarkup(),
  ): Promise<TelegramMessage | undefined> {
    try {
      return await this.callApi<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: markdownToTelegramHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
    } catch (error) {
      logger.warn("Telegram status message send failed", { chatId, error });
      return undefined;
    }
  }

  private async updateStatusMessage(
    chatId: string,
    messageId: number | undefined,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<void> {
    if (!messageId) {
      await this.sendMessage(chatId, text, replyMarkup);
      return;
    }

    try {
      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: markdownToTelegramHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (error) {
      logger.warn("Telegram status message edit failed", { chatId, messageId, error });
      await this.sendMessage(chatId, text, replyMarkup);
    }
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

  private async sendPhotoBuffer(
    chatId: string,
    image: ImageData,
    caption?: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<unknown> {
    const form = new FormData();

    form.append("chat_id", chatId);
    form.append(
      "photo",
      new Blob([new Uint8Array(image.buffer)], {
        type: image.contentType,
      }),
      image.filename,
    );

    if (caption) {
      form.append("caption", markdownToTelegramHtml(shortenTelegramCaption(caption)));
      form.append("parse_mode", "HTML");
    }

    if (replyMarkup) {
      form.append("reply_markup", JSON.stringify(replyMarkup));
    }

    return this.callMultipart("sendPhoto", form);
  }

  private async downloadTelegramPhoto(message: TelegramMessage): Promise<ImageData> {
    const photo = [...(message.photo ?? [])].sort(compareTelegramPhotos).at(-1);

    if (!photo) {
      throw new Error("Telegram message does not contain a photo");
    }

    const file = await this.callApi<TelegramFile>("getFile", {
      file_id: photo.file_id,
    });

    if (!file.file_path) {
      throw new Error("Telegram did not return file_path for photo");
    }

    const sourceUrl = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`;
    const response = await fetchWithTimeout(
      sourceUrl,
      { method: "GET" },
      this.config.httpTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Telegram file download failed with ${response.status}`);
    }

    const filename = sanitizeTelegramFilename(file.file_path);
    const contentType = resolveTelegramPhotoContentType(
      filename,
      response.headers.get("content-type"),
    );

    return {
      buffer: await readResponseBuffer(response, this.config.maxDownloadBytes),
      contentType,
      filename,
    };
  }

  private async callApi<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.telegramBotToken}/${method}`,
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

  private async callMultipart<T = unknown>(
    method: string,
    form: FormData,
  ): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.telegramBotToken}/${method}`,
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
}

function mainMenuMarkup(): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: appearanceAnalysisButtonText }],
      [{ text: idealOutfitButtonText }],
      [{ text: manualTryOnButtonText }, { text: catalogRefreshButtonText }],
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

function productLinkMarkup(productUrl: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [[{ text: "Перейти к товару", url: productUrl }]],
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
    normalized === "/ideal" ||
    normalized === "/outfit"
  );
}

function isTryOnCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);

  return (
    normalized === normalizeCommandText(manualTryOnButtonText) ||
    normalized === normalizeCommandText(legacyTryOnButtonText) ||
    normalized === "/tryon" ||
    normalized === "/request"
  );
}

function isCatalogCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);

  return (
    normalized === normalizeCommandText(catalogRefreshButtonText) ||
    normalized === "/catalog"
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
    isAppearanceAnalysisCommand(text) ||
    isIdealOutfitCommand(text) ||
    isTryOnCommand(text) ||
    isCatalogCommand(text)
  );
}

function normalizeCommandText(text: string): string {
  return text.trim().toLowerCase();
}

function describeProcessingFlow(flow: ProcessingFlow): string {
  const labels: Record<ProcessingFlow, string> = {
    appearance: "анализ внешности",
    ideal: "идеальный образ",
    tryon: "ручную примерку",
    catalog: "обновление каталога",
  };

  return labels[flow];
}

function renderIdealProgress(stage: string, percent: number): string {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(safePercent / 5);
  const bar = "#".repeat(filled).padEnd(20, "-");

  return [
    "Подбор идеального образа",
    "",
    `Прогресс: [${bar}] ${safePercent}%`,
    `Этап: ${stage}`,
  ].join("\n");
}

function normalizeIdealStyleOptions(plan: IdealOutfitPlan): IdealOutfitOption[] {
  const options = plan.options.length
    ? plan.options
    : plan.categories.length
      ? [
          {
            styleName: plan.styleName,
            summary: plan.summary,
            categories: plan.categories,
          },
        ]
      : [];

  return options
    .filter((option) => option.categories.length > 0)
    .slice(0, 3);
}

function renderIdealStyleOptionsMessage(options: IdealOutfitOption[]): string {
  return [
    "Фото подходит. Выберите один из вариантов стиля:",
    "",
    ...options.map((option, index) => {
      const categories = option.categories.map((entry) => entry.category).join(", ");

      return [
        `**${index + 1}. ${option.styleName ?? `Вариант ${index + 1}`}**`,
        option.summary,
        categories ? `Вещи: ${categories}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    }),
    "",
    "После выбора я локально подберу вещи из каталога и отправлю их в TryOn.",
  ].join("\n\n");
}

function idealStyleOptionsMarkup(options: IdealOutfitOption[]): TelegramReplyMarkup {
  return {
    keyboard: [
      ...options.map((option, index) => [{ text: idealStyleOptionButtonText(option, index) }]),
      [{ text: cancelButtonText }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function selectIdealOutfitOption(
  text: string,
  options: IdealOutfitOption[],
): IdealOutfitOption | undefined {
  const normalized = normalizeCommandText(text);
  const byButton = options.find((option, index) =>
    normalized === normalizeCommandText(idealStyleOptionButtonText(option, index)),
  );

  if (byButton) {
    return byButton;
  }

  const numeric = /^(?:вариант\s*)?(\d+)/i.exec(normalized)?.[1];
  const index = numeric ? Number(numeric) - 1 : -1;

  if (index >= 0 && index < options.length) {
    return options[index];
  }

  return options.find((option) =>
    option.styleName && normalized === normalizeCommandText(option.styleName),
  );
}

function idealStyleOptionButtonText(option: IdealOutfitOption, index: number): string {
  const styleName = option.styleName?.trim() || `Вариант ${index + 1}`;

  return `${index + 1}. ${styleName}`.slice(0, 64);
}
function buildLocalOutfitSelection(
  plan: Pick<IdealOutfitOption, "styleName" | "summary">,
  groups: OutfitCandidateGroup[],
): OutfitSelection {
  return {
    styleName: plan.styleName ?? "Идеальный образ",
    summary: plan.summary ?? "Подобрал вещи из локального каталога по тегам образа.",
    items: groups.flatMap((group) => {
      const first = group.candidates[0];

      if (!first) {
        return [];
      }

      return [
        {
          category: first.category,
          itemId: first.id,
          reason: buildLocalSelectionReason(group.request, first),
        },
      ];
    }).slice(0, 3),
  };
}

function buildLocalSelectionReason(
  request: OutfitCategoryRequest,
  item: GarmentCatalogItem,
): string {
  const matchedTags = [
    ...(request.requiredTags ?? []),
    ...(request.preferredTags ?? []),
  ].filter((tag) => catalogItemContainsTag(item, tag));
  const details = [
    request.color ? `цвет: ${request.color}` : undefined,
    matchedTags.length ? `совпали теги: ${matchedTags.slice(0, 4).join(", ")}` : undefined,
  ].filter(Boolean);

  return details.length
    ? `Лучший кандидат локального каталога, ${details.join("; ")}.`
    : "Лучший кандидат локального каталога по категории и описанию.";
}

function catalogItemContainsTag(item: GarmentCatalogItem, tag: string): boolean {
  const normalized = tag.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return [
    item.category,
    item.title,
    item.brand,
    item.description,
    ...item.tags,
    ...item.colorTags,
    ...item.styleTags,
    ...item.materialTags,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}
function uniqueSelectedCatalogItems(
  selected: OutfitSelectionItem[],
  groups: OutfitCandidateGroup[],
): Array<{ item: GarmentCatalogItem; reason?: string }> {
  const byId = new Map(
    groups.flatMap((group) => group.candidates.map((item) => [item.id, item] as const)),
  );
  const usedCategories = new Set<string>();
  const usedItems = new Set<string>();
  const result: Array<{ item: GarmentCatalogItem; reason?: string }> = [];

  for (const entry of selected) {
    const item = byId.get(entry.itemId);
    const category = normalizeCommandText(item?.category ?? entry.category);

    if (!item || usedItems.has(item.id) || usedCategories.has(category)) {
      continue;
    }

    usedItems.add(item.id);
    usedCategories.add(category);
    result.push({ item, reason: entry.reason });
  }

  if (result.length > 0) {
    return result.slice(0, 3);
  }

  return groups
    .flatMap((group) => {
      const first = group.candidates[0];

      return first
        ? [
            {
              item: first,
              reason: "Лучший кандидат по локальному скорингу.",
            },
          ]
        : [];
    })
    .slice(0, 3);
}

function formatPrice(item: GarmentCatalogItem): string | undefined {
  if (item.price === undefined) {
    return undefined;
  }

  const currency = item.currency ?? "RUB";

  if (currency.toUpperCase() === "RUB") {
    return `Цена: ${Math.round(item.price).toLocaleString("ru-RU")} ₽`;
  }

  return `Цена: ${item.price.toLocaleString("ru-RU")} ${currency}`;
}

function compareTelegramPhotos(a: TelegramPhotoSize, b: TelegramPhotoSize): number {
  const aScore = a.file_size ?? a.width * a.height;
  const bScore = b.file_size ?? b.width * b.height;

  return aScore - bScore;
}

function sanitizeTelegramFilename(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, "-") || "telegram-photo.jpg"
  );
}

function resolveTelegramPhotoContentType(
  filename: string,
  responseContentType: string | null,
): string {
  if (responseContentType?.toLowerCase().startsWith("image/")) {
    return responseContentType;
  }

  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "png") {
    return "image/png";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  if (extension === "gif") {
    return "image/gif";
  }

  return "image/jpeg";
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

function shortenTelegramCaption(text: string): string {
  const maxCaptionLength = 900;

  if (text.length <= maxCaptionLength) {
    return text;
  }

  return text.slice(0, maxCaptionLength - 3).trimEnd() + "...";
}

function friendlyErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  if (error.message.includes("OPENAI_API_KEY")) {
    return "Для анализа и подбора образа нужно заполнить OPENAI_API_KEY в `.env`.";
  }

  if (error.message.includes("PRUNA_API_KEY")) {
    return "Для реальной примерки через Pruna нужно заполнить PRUNA_API_KEY или поставить MONOLITH_TRYON_PROVIDER=mock.";
  }

  if (error.message.includes("Monolith catalog is empty")) {
    return "Локальный каталог пуст. Нажмите «Обновить каталог» или запустите `npm run dev:catalog` из папки `monolith/`.";
  }

  if (error.message.toLowerCase().includes("playwright")) {
    return "Для чтения каталога нужен Playwright Chromium. Запустите `npm run playwright:install`, затем обновите каталог.";
  }

  if (error.name === "AbortError") {
    return "Внешний API не ответил вовремя. Попробуйте еще раз чуть позже.";
  }

  return fallback;
}
