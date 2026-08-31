import { sleep } from "../utils/http.js";
import { createLogger } from ".././utils/logger.js";
import type { MonolithConfig } from "../config.js";
import { MonolithCatalog } from "../catalog/catalog.js";
import type {
  GarmentCatalogItem,
  IdealOutfitPreferences,
  IdealOutfitOption,
  IdealOutfitPlan,
  ImageData,
  OutfitCandidateGroup,
  OutfitCategoryRequest,
  OutfitSelection,
  OutfitSelectionItem,
  PricePreference,
  SizePreference,
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
      mode: "awaiting-ideal-wish";
    }
  | {
      mode: "awaiting-ideal-size";
      userWish?: string;
    }
  | {
      mode: "awaiting-ideal-price";
      userWish?: string;
      sizePreference: SizePreference;
    }
  | {
      mode: "awaiting-ideal-photo";
      userWish?: string;
      sizePreference: SizePreference;
      pricePreference: PricePreference;
    }
  | {
      mode: "awaiting-ideal-style";
      person: StoredImage;
      options: IdealOutfitOption[];
      userWish?: string;
      sizePreference: SizePreference;
      pricePreference: PricePreference;
    }
  | {
      mode: "awaiting-ideal-catalog-fallback";
      person: StoredImage;
      preferences: IdealOutfitPreferences;
    }
  | {
      mode: "awaiting-ideal-wish-retry";
      person: StoredImage;
      sizePreference: SizePreference;
      pricePreference: PricePreference;
      previousWish?: string;
    };

type ProcessingFlow = "appearance" | "ideal";

interface ProcessingState {
  flow: ProcessingFlow;
  startedAt: number;
}
interface IdealOptionAvailability {
  option: IdealOutfitOption;
  groups: OutfitCandidateGroup[];
  missing: OutfitCandidateGroup[];
}

const appearanceAnalysisButtonText = "Анализ внешности";
const idealOutfitButtonText = "Идеальный образ";
const legacyAppearanceAnalysisButtonText = "Разбор внешности";
const cancelButtonText = "Отмена";
const skipWishButtonText = "Пропустить";
const relaxIdealWishButtonText = "Предложить без пожелания";
const changeIdealWishButtonText = "Изменить пожелание";
const anySizeButtonText = "Любой размер";
const sizeSmallButtonText = "XS-S";
const sizeMediumButtonText = "M-L";
const sizeLargeButtonText = "XL-XXL";
const anyBudgetButtonText = "Любой бюджет";
const budgetUnder10kButtonText = "до 10 000 ₽";
const budgetUnder30kButtonText = "до 30 000 ₽";
const budgetUnder100kButtonText = "до 100 000 ₽";
const budgetOver100kButtonText = "100 000 ₽+";

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
      logger.info("Telegram update ignored while monolith flow is running", {
        chatId,
        flow: processing.flow,
        text,
        hasPhoto: Boolean(message.photo?.length),
      });
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


    if (!text && message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Сначала выберите сценарий: анализ внешности или идеальный образ.",
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

    if (session.mode === "awaiting-ideal-wish") {
      await this.handleIdealWishStep(message);
      return;
    }

    if (session.mode === "awaiting-ideal-size") {
      await this.handleIdealSizeStep(message, session);
      return;
    }

    if (session.mode === "awaiting-ideal-price") {
      await this.handleIdealPriceStep(message, session);
      return;
    }

    if (session.mode === "awaiting-ideal-photo") {
      await this.handleIdealOutfitPhotoStep(message, session);
      return;
    }

    if (session.mode === "awaiting-ideal-style") {
      await this.handleIdealStyleSelectionStep(message, session);
      return;
    }

    if (session.mode === "awaiting-ideal-catalog-fallback") {
      await this.handleIdealCatalogFallbackStep(message, session);
      return;
    }

    if (session.mode === "awaiting-ideal-wish-retry") {
      await this.handleIdealWishRetryStep(message, session);
      return;
    }

    const exhaustive: never = session;
    void exhaustive;
  }

  private sendStartMessage(chatId: string): Promise<unknown> {
    return this.sendMessage(
      chatId,
      [
        "Привет! Это отдельный MVP-монолит TryOnService: один Telegram-бот сам хранит фото, читает каталог одежды, подбирает вещи и собирает примерку.",
        "",
        "**Анализ внешности**: пришлите фото с видимым лицом, я дам компактный разбор.",
        "**Идеальный образ**: пришлите фото в полный рост или по колено, я выберу стиль, найду вещи в локальном каталоге и сделаю примерку.",
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
      "Фото принято. Делаю разбор внешности.",
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
      mode: "awaiting-ideal-wish",
    });

    return this.sendMessage(
      chatId,
      [
        "Сначала напишите пожелание к образу: случай, настроение, стиль, цвета или ограничения.",
        "Можно просто нажать «Пропустить», тогда я подберу образ сам.",
      ].join("\n"),
      idealWishMarkup(),
    );
  }

  private async handleIdealWishStep(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? message.caption?.trim();

    if (!text) {
      await this.sendMessage(
        chatId,
        "Напишите короткое пожелание к образу или нажмите «Пропустить».",
        idealWishMarkup(),
      );
      return;
    }

    const userWish = isSkipWishCommand(text) ? undefined : text;

    if (userWish && userWish.length > 500) {
      await this.sendMessage(
        chatId,
        "Пожелание слишком длинное. Напишите короче: стиль, случай и пару важных деталей.",
        idealWishMarkup(),
      );
      return;
    }

    if (userWish && !looksLikeMeaningfulIdealWish(userWish)) {
      await this.sendMessage(
        chatId,
        "Не понял пожелание к образу. Напишите обычными словами: для какого случая нужен образ, какие цвета/стиль хотите, или нажмите «Пропустить».",
        idealWishMarkup(),
      );
      return;
    }

    this.sessions.set(chatId, {
      mode: "awaiting-ideal-size",
      userWish,
    });

    await this.sendMessage(
      chatId,
      [
        "Выберите размерный диапазон.",
        "Если не уверены или хотите больше вариантов, выбирайте «Любой размер».",
      ].join("\n"),
      await this.buildSizePreferenceMarkup(),
    );
  }

  private async handleIdealSizeStep(
    message: TelegramMessage,
    session: Extract<ChatSession, { mode: "awaiting-ideal-size" }>,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? message.caption?.trim();
    const sizePreference = text ? parseSizePreference(text) : undefined;

    if (!sizePreference) {
      await this.sendMessage(chatId, "Выберите размер кнопкой ниже или нажмите «Отмена».", await this.buildSizePreferenceMarkup());
      return;
    }

    this.sessions.set(chatId, {
      mode: "awaiting-ideal-price",
      userWish: session.userWish,
      sizePreference,
    });

    await this.sendMessage(
      chatId,
      "Выберите бюджет на одну вещь. Это фильтр для каталога, не общая сумма образа.",
      await this.buildPricePreferenceMarkup(sizePreference),
    );
  }

  private async handleIdealPriceStep(
    message: TelegramMessage,
    session: Extract<ChatSession, { mode: "awaiting-ideal-price" }>,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? message.caption?.trim();
    const pricePreference = text ? parsePricePreference(text) : undefined;

    if (!pricePreference) {
      await this.sendMessage(chatId, "Выберите бюджет кнопкой ниже или нажмите «Отмена».", await this.buildPricePreferenceMarkup(session.sizePreference));
      return;
    }

    this.sessions.set(chatId, {
      mode: "awaiting-ideal-photo",
      userWish: session.userWish,
      sizePreference: session.sizePreference,
      pricePreference,
    });

    await this.sendMessage(
      chatId,
      [
        "Теперь пришлите фото в полный рост или хотя бы по колено.",
        "Обувь может быть не видна, тогда я просто не буду подбирать обувь.",
        "Фильтры: " + renderIdealPreferenceSummary({
          userWish: session.userWish,
          sizePreference: session.sizePreference,
          pricePreference,
        }),
      ].join("\n"),
      cancelMarkup(),
    );
  }

  private async handleIdealOutfitPhotoStep(
    message: TelegramMessage,
    session: Extract<ChatSession, { mode: "awaiting-ideal-photo" }>,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const preferences: IdealOutfitPreferences = {
      userWish: session.userWish,
      sizePreference: session.sizePreference,
      pricePreference: session.pricePreference,
    };

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

    void this.runIdealOutfit(message, preferences, status?.message_id).catch((error) => {
      logger.error("Ideal outfit background task crashed", {
        chatId,
        error,
      });
    });
  }

  private async runIdealOutfit(
    message: TelegramMessage,
    preferences: IdealOutfitPreferences,
    statusMessageId?: number,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    try {
      const image = await this.downloadTelegramPhoto(message);
      const stored = await this.storage.saveImage("telegram-input", image, {
        chatId,
        flow: "ideal",
        username: message.from?.username,
        userWish: preferences.userWish,
        sizePreference: preferences.sizePreference,
        pricePreference: preferences.pricePreference,
      });

      logger.info("Ideal outfit photo saved", {
        chatId,
        path: stored.relativePath,
        sizeBytes: stored.sizeBytes,
      });
      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("читаю каталог", 18));

      const items = await this.catalog.ensureReady();
      const catalogHints = await this.catalog.categoryTagHints(preferences);

      if (!this.config.catalog.enabled || items.length === 0 || catalogHints.length === 0) {
        throw new Error("Monolith catalog is empty");
      }

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("анализирую фото и собираю варианты", 44));
      const plan = await this.openai.planIdealOutfit(image, catalogHints, preferences);
      const options = normalizeIdealStyleOptions(plan, preferences);

      if (!plan.accepted || options.length === 0) {
        const rejectionMessage = plan.rejectionMessage ??
          "Фото не подходит для подбора образа. Пришлите фото в полный рост или хотя бы по колено.";

        if (preferences.userWish && isIdealWishRejection(rejectionMessage)) {
          await this.askForIdealWishRetry(chatId, stored, preferences, statusMessageId, rejectionMessage);
          return;
        }

        this.sessions.set(chatId, {
          mode: "awaiting-ideal-photo",
          userWish: preferences.userWish,
          sizePreference: preferences.sizePreference,
          pricePreference: preferences.pricePreference,
        });
        statusMessageId = await this.updateStatusMessage(
          chatId,
          statusMessageId,
          rejectionMessage,
          cancelMarkup(),
        );
        return;
      }

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("проверяю наличие вещей", 70));
      const availability = await this.checkIdealOptionsAvailability(chatId, options);
      const availableOptions = availability
        .filter((entry) => entry.missing.length === 0)
        .map((entry) => entry.option)
        .slice(0, 3);

      if (availableOptions.length === 0) {
        await this.offerIdealPlanCatalogFallback(chatId, stored, options, availability, preferences, statusMessageId);
        return;
      }

      this.sessions.set(chatId, {
        mode: "awaiting-ideal-style",
        person: stored,
        options: availableOptions,
        userWish: preferences.userWish,
        sizePreference: preferences.sizePreference,
        pricePreference: preferences.pricePreference,
      });
      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("варианты готовы", 100));
      await this.sendMessage(
        chatId,
        renderIdealStyleOptionsMessage(availableOptions, options.length),
        idealStyleOptionsMarkup(availableOptions),
      );
    } catch (error) {
      logger.error("Ideal outfit plan failed", {
        chatId,
        provider: this.tryOn.name,
        error,
      });
      statusMessageId = await this.updateStatusMessage(
        chatId,
        statusMessageId,
        friendlyErrorMessage(error, "Не удалось подготовить варианты образа. Попробуйте другое фото или проверьте локальный каталог."),
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

  private async askForIdealWishRetry(
    chatId: string,
    person: StoredImage,
    preferences: IdealOutfitPreferences,
    statusMessageId: number | undefined,
    rejectionMessage: string,
  ): Promise<void> {
    this.sessions.set(chatId, {
      mode: "awaiting-ideal-wish-retry",
      person,
      sizePreference: preferences.sizePreference,
      pricePreference: preferences.pricePreference,
      previousWish: preferences.userWish,
    });
    logger.info("Ideal outfit wish retry requested", {
      chatId,
      sizePreference: preferences.sizePreference,
      pricePreference: preferences.pricePreference,
      previousWish: preferences.userWish,
      rejectionMessage,
    });
    await this.updateStatusMessage(
      chatId,
      statusMessageId,
      [
        rejectionMessage,
        "",
        "Фото уже сохранено. Напишите новое пожелание или нажмите «Пропустить», и я пересоберу варианты без повторной загрузки фото.",
      ].join("\n"),
    );
    await this.sendMessage(
      chatId,
      "Напишите новое пожелание к образу или нажмите «Пропустить».",
      idealWishMarkup(),
    );
  }

  private async handleIdealWishRetryStep(
    message: TelegramMessage,
    session: Extract<ChatSession, { mode: "awaiting-ideal-wish-retry" }>,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? message.caption?.trim();

    if (!text || message.photo?.length) {
      await this.sendMessage(
        chatId,
        "Фото уже есть. Напишите новое пожелание к образу обычными словами или нажмите «Пропустить».",
        idealWishMarkup(),
      );
      return;
    }

    const userWish = isSkipWishCommand(text) ? undefined : text;

    if (userWish && userWish.length > 500) {
      await this.sendMessage(
        chatId,
        "Пожелание слишком длинное. Напишите короче: стиль, случай и пару важных деталей.",
        idealWishMarkup(),
      );
      return;
    }

    if (userWish && !looksLikeMeaningfulIdealWish(userWish)) {
      await this.sendMessage(
        chatId,
        "Пожелание выглядит как случайный набор символов. Переформулируйте его коротко, например: «повседневный образ в темных цветах».",
        idealWishMarkup(),
      );
      return;
    }

    const preferences: IdealOutfitPreferences = {
      userWish,
      sizePreference: session.sizePreference,
      pricePreference: session.pricePreference,
    };

    this.sessions.delete(chatId);
    this.processing.set(chatId, { flow: "ideal", startedAt: Date.now() });
    const status = await this.sendStatusMessage(
      chatId,
      renderIdealProgress(userWish ? "пересобираю с новым пожеланием" : "подбираю без пожелания", 8),
    );

    void this.runRelaxedIdealOutfitFromStoredPhoto(chatId, session.person, preferences, status?.message_id).catch((error) => {
      logger.error("Ideal outfit wish retry background task crashed", {
        chatId,
        error,
      });
    });
  }

  private async handleIdealCatalogFallbackStep(
    message: TelegramMessage,
    session: Extract<ChatSession, { mode: "awaiting-ideal-catalog-fallback" }>,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? message.caption?.trim();

    if (text && isRelaxIdealWishCommand(text)) {
      const relaxedPreferences: IdealOutfitPreferences = {
        ...session.preferences,
        userWish: undefined,
      };
      this.sessions.delete(chatId);
      this.processing.set(chatId, { flow: "ideal", startedAt: Date.now() });
      const status = await this.sendStatusMessage(
        chatId,
        renderIdealProgress("подбираю без пожелания", 8),
      );

      void this.runRelaxedIdealOutfitFromStoredPhoto(chatId, session.person, relaxedPreferences, status?.message_id).catch((error) => {
        logger.error("Ideal outfit relaxed fallback background task crashed", {
          chatId,
          error,
        });
      });
      return;
    }

    if (text && isChangeIdealWishCommand(text)) {
      this.sessions.set(chatId, {
        mode: "awaiting-ideal-wish-retry",
        person: session.person,
        sizePreference: session.preferences.sizePreference,
        pricePreference: session.preferences.pricePreference,
        previousWish: session.preferences.userWish,
      });
      await this.sendMessage(
        chatId,
        "Ок, напишите новое пожелание к образу или нажмите «Пропустить». Фото уже сохранено.",
        idealWishMarkup(),
      );
      return;
    }

    await this.sendMessage(
      chatId,
      "Выберите: предложить новый вариант без пожелания, изменить пожелание или отменить сценарий.",
      idealCatalogFallbackMarkup(),
    );
  }

  private async runRelaxedIdealOutfitFromStoredPhoto(
    chatId: string,
    stored: StoredImage,
    preferences: IdealOutfitPreferences,
    statusMessageId?: number,
  ): Promise<void> {
    try {
      const image = await this.storage.readImage(stored);

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("читаю каталог", 18));
      const items = await this.catalog.ensureReady();
      const catalogHints = await this.catalog.categoryTagHints(preferences);

      if (!this.config.catalog.enabled || items.length === 0 || catalogHints.length === 0) {
        throw new Error("Monolith catalog is empty");
      }

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress(preferences.userWish ? "собираю варианты с новым пожеланием" : "собираю варианты без пожелания", 44));
      const plan = await this.openai.planIdealOutfit(image, catalogHints, preferences);
      const options = normalizeIdealStyleOptions(plan, preferences);

      if (!plan.accepted || options.length === 0) {
        const rejectionMessage = plan.rejectionMessage ??
          "Не получилось предложить образ. Попробуйте написать другое пожелание или отправить другое фото.";

        if (preferences.userWish && isIdealWishRejection(rejectionMessage)) {
          await this.askForIdealWishRetry(chatId, stored, preferences, statusMessageId, rejectionMessage);
          return;
        }

        this.sessions.set(chatId, {
          mode: "awaiting-ideal-photo",
          userWish: preferences.userWish,
          sizePreference: preferences.sizePreference,
          pricePreference: preferences.pricePreference,
        });
        statusMessageId = await this.updateStatusMessage(
          chatId,
          statusMessageId,
          rejectionMessage,
        );
        await this.sendMessage(chatId, "Пришлите другое фото или нажмите «Отмена».", cancelMarkup());
        return;
      }
      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("проверяю наличие вещей", 70));
      const availability = await this.checkIdealOptionsAvailability(chatId, options);
      const availableOptions = availability
        .filter((entry) => entry.missing.length === 0)
        .map((entry) => entry.option)
        .slice(0, 3);

      if (availableOptions.length === 0) {
        await this.offerIdealPlanCatalogFallback(chatId, stored, options, availability, preferences, statusMessageId);
        return;
      }

      this.sessions.set(chatId, {
        mode: "awaiting-ideal-style",
        person: stored,
        options: availableOptions,
        userWish: preferences.userWish,
        sizePreference: preferences.sizePreference,
        pricePreference: preferences.pricePreference,
      });
      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("варианты готовы", 100));
      await this.sendMessage(
        chatId,
        [
          preferences.userWish
            ? "Я учёл новое пожелание и подготовил доступные варианты по фото, размеру и бюджету."
            : "Я убрал прежнее пожелание и подготовил доступные варианты по фото, размеру и бюджету.",
          "",
          renderIdealStyleOptionsMessage(availableOptions, options.length),
        ].join("\n"),
        idealStyleOptionsMarkup(availableOptions),
      );
    } catch (error) {
      logger.error("Ideal outfit relaxed fallback failed", {
        chatId,
        provider: this.tryOn.name,
        error,
      });
      statusMessageId = await this.updateStatusMessage(
        chatId,
        statusMessageId,
        friendlyErrorMessage(error, "Не удалось подготовить вариант без пожелания. Попробуйте другое фото или проверьте локальный каталог."),
        mainMenuMarkup(),
      );
    } finally {
      this.processing.delete(chatId);
    }
  }

  private async offerIdealCatalogFallback(
    chatId: string,
    person: StoredImage,
    option: IdealOutfitOption,
    groups: OutfitCandidateGroup[],
    statusMessageId?: number,
  ): Promise<void> {
    const preferences = preferencesFromIdealOption(option);
    this.sessions.set(chatId, {
      mode: "awaiting-ideal-catalog-fallback",
      person,
      preferences,
    });
    logger.info("Ideal outfit catalog fallback offered", {
      chatId,
      styleName: option.styleName,
      preferences,
      categories: groups.map((group) => ({
        category: group.request.category,
        query: group.request.query,
        requiredTags: group.request.requiredTags,
        color: group.request.color,
        candidates: group.candidates.length,
      })),
    });

    statusMessageId = await this.updateStatusMessage(
      chatId,
      statusMessageId,
      renderIdealCatalogFallbackMessage(option, groups, preferences),
    );
    await this.sendMessage(
      chatId,
      "Могу предложить новый вариант без этого пожелания на том же фото. Размер и бюджет оставлю такими же.",
      idealCatalogFallbackMarkup(),
    );
  }

  private async runSelectedIdealOutfit(
    chatId: string,
    person: StoredImage,
    option: IdealOutfitOption,
    statusMessageId?: number,
  ): Promise<void> {
    try {
      const image = await this.storage.readImage(person);

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("читаю каталог", 18));
      const items = await this.catalog.ensureReady();

      if (!this.config.catalog.enabled || items.length === 0) {
        throw new Error("Monolith catalog is empty");
      }

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("подбираю вещи", 46));
      const groups = await this.buildCandidateGroups(option.categories);
      logger.info("Ideal outfit candidates built", {
        chatId,
        styleName: option.styleName,
        categories: groups.map((group) => ({
          category: group.request.category,
          gender: group.request.gender,
          sizePreference: group.request.sizePreference,
          pricePreference: group.request.pricePreference,
          userWish: group.request.userWish?.slice(0, 160),
          candidates: group.candidates.length,
          prices: group.candidates.slice(0, 5).map((item) => item.price?.amount ?? null),
          itemIds: group.candidates.slice(0, 5).map((item) => item.id),
        })),
      });
      const missing = groups.filter((group) => group.candidates.length === 0);
      const usableGroups = groups.filter((group) => group.candidates.length > 0);

      if (missing.length > 0) {
        await this.offerIdealCatalogFallback(chatId, person, option, groups, statusMessageId);
        return;
      }

      const selection = buildLocalOutfitSelection(option, usableGroups);
      const selected = uniqueSelectedCatalogItems(selection.items, usableGroups);

      if (selected.length === 0) {
        throw new Error("Local catalog scoring did not select catalog items");
      }

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("готовлю изображения", 70));
      const garmentImages = await Promise.all(
        selected.map((entry) => this.catalog.getImage(entry.item)),
      );

      statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("делаю примерку", 86));
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
        statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("готово", 100));
        await this.sendPhotoBuffer(
          chatId,
          result.image,
          [
            `**${selection.styleName}**`,
            selection.summary,
            "",
            "Готово, собрал примерку по выбранному образу.",
          ].join("\n"),
          mainMenuMarkup(),
        );
      } else {
        statusMessageId = await this.updateStatusMessage(chatId, statusMessageId, renderIdealProgress("готово", 100));
        await this.sendMessage(
          chatId,
          `**${selection.styleName}**\n${selection.summary}\n\nГотово, подборка товаров ниже. Изображение примерки пока не получилось собрать.`,
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
      statusMessageId = await this.updateStatusMessage(
        chatId,
        statusMessageId,
        friendlyErrorMessage(error, "Не удалось собрать идеальный образ. Попробуйте другой вариант стиля, другое фото или проверьте локальный каталог."),
        mainMenuMarkup(),
      );
    } finally {
      this.processing.delete(chatId);
    }
  }
  private async buildSizePreferenceMarkup(): Promise<TelegramReplyMarkup> {
    try {
      return sizePreferenceMarkup(await this.catalog.sizePreferenceCounts());
    } catch (error) {
      logger.warn("Telegram could not build size counts; falling back to plain buttons", { error });
      return sizePreferenceMarkup();
    }
  }

  private async buildPricePreferenceMarkup(
    sizePreference: SizePreference,
  ): Promise<TelegramReplyMarkup> {
    try {
      return pricePreferenceMarkup(await this.catalog.pricePreferenceCounts({ sizePreference }));
    } catch (error) {
      logger.warn("Telegram could not build price counts; falling back to plain buttons", { error });
      return pricePreferenceMarkup();
    }
  }

  private async checkIdealOptionsAvailability(
    chatId: string,
    options: IdealOutfitOption[],
  ): Promise<IdealOptionAvailability[]> {
    const availability: IdealOptionAvailability[] = [];

    for (const option of options.slice(0, 3)) {
      const groups = await this.buildCandidateGroups(option.categories);
      const missing = groups.filter((group) => group.candidates.length === 0);

      logger.info("Ideal outfit option availability checked", {
        chatId,
        styleName: option.styleName,
        available: missing.length === 0,
        categories: groups.map((group) => ({
          category: group.request.category,
          gender: group.request.gender,
          sizePreference: group.request.sizePreference,
          pricePreference: group.request.pricePreference,
          requiredTags: group.request.requiredTags,
          color: group.request.color,
          candidates: group.candidates.length,
          prices: group.candidates.slice(0, 3).map((item) => item.price?.amount ?? null),
        })),
      });

      availability.push({ option, groups, missing });
    }

    return availability;
  }

  private async offerIdealPlanCatalogFallback(
    chatId: string,
    person: StoredImage,
    options: IdealOutfitOption[],
    availability: IdealOptionAvailability[],
    preferences: IdealOutfitPreferences,
    statusMessageId?: number,
  ): Promise<void> {
    this.sessions.set(chatId, {
      mode: "awaiting-ideal-catalog-fallback",
      person,
      preferences,
    });
    logger.info("Ideal outfit plan catalog fallback offered", {
      chatId,
      preferences,
      options: availability.map((entry) => ({
        styleName: entry.option.styleName,
        available: entry.missing.length === 0,
        missing: entry.missing.map((group) => ({
          category: group.request.category,
          query: group.request.query,
          requiredTags: group.request.requiredTags,
          color: group.request.color,
        })),
      })),
    });

    statusMessageId = await this.updateStatusMessage(
      chatId,
      statusMessageId,
      renderIdealPlanCatalogFallbackMessage(options, availability, preferences),
    );
    await this.sendMessage(
      chatId,
      preferences.userWish
        ? "Могу предложить новый вариант без этого пожелания на том же фото. Размер и бюджет оставлю такими же."
        : "Можно изменить пожелание, ослабить фильтры через новый сценарий или отменить подбор." ,
      idealCatalogFallbackMarkup(),
    );
  }

  private async buildCandidateGroups(    requests: OutfitCategoryRequest[],
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
      "**" + item.category + ": " + item.title + "**",
      "Сегмент: " + labelForGender(item.gender),
      item.sizes.length ? "Размеры: " + item.sizes.slice(0, 8).join(", ") : undefined,
      item.colors.length ? "Цвета: " + item.colors.slice(0, 5).join(", ") : undefined,
      formatPrice(item),
      reason ? "Почему подходит: " + reason : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const markup = productLinkMarkup(item.productUrl);

    if (item.imageFile) {
      try {
        const image = await this.catalog.getImage(item);
        await this.sendPhotoBuffer(chatId, image, caption, markup);
        return;
      } catch (error) {
        logger.warn("Telegram could not send local catalog image from buffer", {
          chatId,
          itemId: item.id,
          imageFile: item.imageFile,
          error,
        });
      }
    }

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
      caption + "\n[Перейти к товару](" + item.productUrl + ")",
      mainMenuMarkup(),
    );
  }
  private async sendActiveSessionMessage(
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
      case "awaiting-ideal-wish":
        return this.sendMessage(
          chatId,
          "Сейчас открыт идеальный образ. Напишите пожелание к образу, нажмите «Пропустить» или «Отмена».",
          idealWishMarkup(),
        );
      case "awaiting-ideal-size":
        return this.sendMessage(
          chatId,
          "Сейчас нужно выбрать размерный диапазон или нажать «Отмена».",
          await this.buildSizePreferenceMarkup(),
        );
      case "awaiting-ideal-price":
        return this.sendMessage(
          chatId,
          "Сейчас нужно выбрать бюджет на одну вещь или нажать «Отмена».",
          await this.buildPricePreferenceMarkup(session.sizePreference),
        );
      case "awaiting-ideal-photo":
        return this.sendMessage(
          chatId,
          [
            "Сейчас открыт идеальный образ. Пришлите фото в полный рост или по колено, либо нажмите «Отмена».",
            "Фильтры: " + renderIdealPreferenceSummary(session),
          ].join("\n"),
          cancelMarkup(),
        );
      case "awaiting-ideal-style":
        return this.sendMessage(
          chatId,
          "Сейчас нужно выбрать один из трех вариантов стиля или нажать «Отмена».",
          idealStyleOptionsMarkup(session.options),
        );
      case "awaiting-ideal-catalog-fallback":
        return this.sendMessage(
          chatId,
          "Под текущие пожелания и фильтры каталог не дал достаточно подходящих вещей. Могу предложить новый вариант без пожелания на том же фото или начать заново с другим пожеланием.",
          idealCatalogFallbackMarkup(),
        );
      case "awaiting-ideal-wish-retry":
        return this.sendMessage(
          chatId,
          "Фото уже сохранено. Напишите новое пожелание к образу, нажмите «Пропустить» или «Отмена».",
          idealWishMarkup(),
        );
    }

    const exhaustive: never = session;
    return Promise.resolve(exhaustive);
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
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<TelegramMessage | undefined> {
    try {
      return await this.callApi<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: markdownToTelegramHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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
  ): Promise<number | undefined> {
    if (!messageId) {
      const status = await this.sendStatusMessage(chatId, text, replyMarkup);
      return status?.message_id;
    }

    try {
      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: markdownToTelegramHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(isInlineReplyMarkup(replyMarkup) ? { reply_markup: replyMarkup } : {}),
      });
      return messageId;
    } catch (error) {
      if (isTelegramMessageNotModified(error)) {
        return messageId;
      }

      logger.warn("Telegram status message edit failed; recreating status message", { chatId, messageId, error });

      if (!(await this.deleteMessage(chatId, messageId))) {
        return messageId;
      }

      const status = await this.sendStatusMessage(chatId, text, replyMarkup);
      return status?.message_id;
    }
  }

  private async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.callApi("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
      return true;
    } catch (error) {
      logger.warn("Telegram status message delete failed", { chatId, messageId, error });
      return false;
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

function idealCatalogFallbackMarkup(): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: relaxIdealWishButtonText }],
      [{ text: changeIdealWishButtonText }],
      [{ text: cancelButtonText }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function idealWishMarkup(): TelegramReplyMarkup {
  return {
    keyboard: [[{ text: skipWishButtonText }], [{ text: cancelButtonText }]],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function sizePreferenceMarkup(
  counts: Partial<Record<SizePreference, number>> = {},
): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: sizeFilterButtonText(anySizeButtonText, "any", counts) }],
      [
        { text: sizeFilterButtonText(sizeSmallButtonText, "xs-s", counts) },
        { text: sizeFilterButtonText(sizeMediumButtonText, "m-l", counts) },
      ],
      [{ text: sizeFilterButtonText(sizeLargeButtonText, "xl-xxl", counts) }],
      [{ text: cancelButtonText }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function pricePreferenceMarkup(
  counts: Partial<Record<PricePreference, number>> = {},
): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: priceFilterButtonText(anyBudgetButtonText, "any", counts) }],
      [
        { text: priceFilterButtonText(budgetUnder10kButtonText, "under-10k", counts) },
        { text: priceFilterButtonText(budgetUnder30kButtonText, "under-30k", counts) },
      ],
      [
        { text: priceFilterButtonText(budgetUnder100kButtonText, "under-100k", counts) },
        { text: priceFilterButtonText(budgetOver100kButtonText, "over-100k", counts) },
      ],
      [{ text: cancelButtonText }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function sizeFilterButtonText(
  label: string,
  preference: SizePreference,
  counts: Partial<Record<SizePreference, number>>,
): string {
  return filterButtonText(label, counts[preference]);
}

function priceFilterButtonText(
  label: string,
  preference: PricePreference,
  counts: Partial<Record<PricePreference, number>>,
): string {
  return filterButtonText(label, counts[preference]);
}

function filterButtonText(label: string, count: number | undefined): string {
  return typeof count === "number" ? label + " (" + count + ")" : label;
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

function isInlineReplyMarkup(replyMarkup: TelegramReplyMarkup | undefined): boolean {
  return Boolean(replyMarkup && Array.isArray(replyMarkup.inline_keyboard));
}

function isTelegramMessageNotModified(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("message is not modified");
}

function isRelaxIdealWishCommand(text: string): boolean {
  return normalizeCommandText(text) === normalizeCommandText(relaxIdealWishButtonText);
}

function isChangeIdealWishCommand(text: string): boolean {
  return normalizeCommandText(text) === normalizeCommandText(changeIdealWishButtonText);
}

function isSkipWishCommand(text: string): boolean {
  return normalizeCommandText(text) === normalizeCommandText(skipWishButtonText);
}

function parseSizePreference(text: string): SizePreference | undefined {
  const normalized = normalizeFilterCommandText(text);

  if (normalized === normalizeCommandText(anySizeButtonText)) {
    return "any";
  }

  if (normalized === normalizeCommandText(sizeSmallButtonText)) {
    return "xs-s";
  }

  if (normalized === normalizeCommandText(sizeMediumButtonText)) {
    return "m-l";
  }

  if (normalized === normalizeCommandText(sizeLargeButtonText)) {
    return "xl-xxl";
  }

  return undefined;
}

function parsePricePreference(text: string): PricePreference | undefined {
  const normalized = normalizeFilterCommandText(text);

  if (normalized === normalizeCommandText(anyBudgetButtonText)) {
    return "any";
  }

  if (normalized === normalizeCommandText(budgetUnder10kButtonText)) {
    return "under-10k";
  }

  if (normalized === normalizeCommandText(budgetUnder30kButtonText)) {
    return "under-30k";
  }

  if (normalized === normalizeCommandText(budgetUnder100kButtonText)) {
    return "under-100k";
  }

  if (normalized === normalizeCommandText(budgetOver100kButtonText)) {
    return "over-100k";
  }

  return undefined;
}

function renderIdealPreferenceSummary(preferences: IdealOutfitPreferences): string {
  return [
    preferences.userWish ? "пожелание: " + preferences.userWish : "пожелание: свободный подбор",
    "размер: " + renderSizePreferenceLabel(preferences.sizePreference),
    "бюджет: " + renderPricePreferenceLabel(preferences.pricePreference),
  ].join("; ");
}

function renderSizePreferenceLabel(preference: SizePreference): string {
  const labels: Record<SizePreference, string> = {
    any: "любой",
    "xs-s": "XS-S",
    "m-l": "M-L",
    "xl-xxl": "XL-XXL",
  };

  return labels[preference];
}

function renderPricePreferenceLabel(preference: PricePreference): string {
  const labels: Record<PricePreference, string> = {
    any: "любой",
    "under-10k": "до 10 000 ₽",
    "under-30k": "до 30 000 ₽",
    "under-100k": "до 100 000 ₽",
    "over-100k": "100 000 ₽+",
  };

  return labels[preference];
}

function looksLikeMeaningfulIdealWish(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  const letters = compact.match(/[A-Za-zА-Яа-яЁё]/g)?.length ?? 0;
  const words = compact.match(/[A-Za-zА-Яа-яЁё]{2,}/g) ?? [];
  const nonSpaceLength = compact.replace(/\s/g, "").length;

  if (letters < 3 || words.length === 0 || nonSpaceLength === 0) {
    return false;
  }

  if (letters / nonSpaceLength < 0.35) {
    return false;
  }

  const lowered = compact.toLowerCase().replace(/\s+/g, "");
  const loweredWords = words.map((word) => word.toLowerCase());

  if (/(.)\1{5,}/u.test(lowered) || /(.{2,4})\1{3,}/u.test(lowered)) {
    return false;
  }

  if (["asdf", "qwer", "zxcv", "йцук", "фыва"].some((run) => lowered.includes(run))) {
    return false;
  }

  const knownWishFragments = [
    "хочу", "нуж", "образ", "стил", "одеж", "вещ", "лук", "look", "outfit",
    "повседнев", "офис", "делов", "свидан", "вечер", "празд", "свад", "работ",
    "casual", "smart", "street", "streetwear", "classic", "минимал", "оверсайз",
    "особ", "необыч", "ярк", "спокой", "строг", "сдерж", "романт", "спорт",
    "темн", "светл", "черн", "бел", "син", "сер", "беж", "крас", "зел", "радуж",
    "рубаш", "футбол", "худи", "брюк", "джинс", "куртк", "пидж", "пальт", "свит",
    "единорог", "принт", "цвет", "кож", "лен", "хлоп", "шерст", "деним", "кибер", "панк", "футур",
  ];

  if (knownWishFragments.some((fragment) => lowered.includes(fragment))) {
    return true;
  }

  const hasVeryLongUnknownWord = loweredWords.some((word) => word.length >= 18);
  const averageWordLength = letters / Math.max(words.length, 1);

  if (hasVeryLongUnknownWord || averageWordLength > 12) {
    return false;
  }

  return words.length >= 3 && letters >= 10;
}

function isIdealWishRejection(message: string): boolean {
  const normalized = normalizeCommandText(message);

  return normalized.includes("пожел") ||
    normalized.includes("переформули") ||
    normalized.includes("случайный набор") ||
    normalized.includes("не про стиль") ||
    normalized.includes("не про одеж");
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
    isIdealOutfitCommand(text)
  );
}

function normalizeFilterCommandText(text: string): string {
  return normalizeCommandText(text).replace(/\s*\([0-9 ]+\)\s*$/, "").trim();
}

function normalizeCommandText(text: string): string {
  return text.trim().toLowerCase();
}

function describeProcessingFlow(flow: ProcessingFlow): string {
  const labels: Record<ProcessingFlow, string> = {
    appearance: "анализ внешности",
    ideal: "идеальный образ",
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
    "Прогресс: [" + bar + "] " + safePercent + "%",
    "Этап: " + stage,
  ].join("\n");
}

function preferencesFromIdealOption(option: IdealOutfitOption): IdealOutfitPreferences {
  const firstCategory = option.categories[0];

  return {
    userWish: option.userWish ?? firstCategory?.userWish,
    sizePreference: option.sizePreference ?? firstCategory?.sizePreference ?? "any",
    pricePreference: option.pricePreference ?? firstCategory?.pricePreference ?? "any",
  };
}

function renderIdealCatalogFallbackMessage(
  option: IdealOutfitOption,
  groups: OutfitCandidateGroup[],
  preferences: IdealOutfitPreferences,
): string {
  const missedGroups = groups.filter((group) => group.candidates.length === 0);
  const missedLines = (missedGroups.length ? missedGroups : groups)
    .map((group) => {
      const tags = [
        ...(group.request.requiredTags ?? []),
        ...(group.request.color ? [group.request.color] : []),
      ].filter(Boolean).slice(0, 5);
      const tagText = tags.length ? "; признаки: " + tags.join(", ") : "";

      return "- " + group.request.category + ": " + group.request.query + tagText;
    });

  return [
    "Не нашёл достаточно вещей в каталоге под выбранный вариант.",
    "",
    option.styleName ? "Стиль: **" + option.styleName + "**" : undefined,
    "Фильтры: " + renderIdealPreferenceSummary(preferences),
    preferences.userWish
      ? "Похоже, каталог сейчас не закрывает это пожелание достаточно точно. Лучше честно не собирать случайный образ из ближайших вещей."
      : "Похоже, в каталоге не хватает вещей под выбранные категории и фильтры.",
    "",
    "Что не сошлось:",
    ...missedLines,
  ].filter(Boolean).join("\n");
}

function renderIdealPlanCatalogFallbackMessage(
  options: IdealOutfitOption[],
  availability: IdealOptionAvailability[],
  preferences: IdealOutfitPreferences,
): string {
  const unavailable = availability.filter((entry) => entry.missing.length > 0);
  const lines = unavailable.flatMap((entry) => {
    const styleName = entry.option.styleName ?? "вариант";

    return entry.missing.map((group) => {
      const tags = [
        ...(group.request.requiredTags ?? []),
        ...(group.request.color ? [group.request.color] : []),
      ].filter(Boolean).slice(0, 5);
      const tagText = tags.length ? "; признаки: " + tags.join(", ") : "";

      return "- " + styleName + ", " + group.request.category + ": " + group.request.query + tagText;
    });
  }).slice(0, 9);

  return [
    "Фото подходит, но доступные варианты не собрались по текущему каталогу.",
    "",
    "Фильтры: " + renderIdealPreferenceSummary(preferences),
    preferences.userWish
      ? "Похоже, каталог сейчас не закрывает пожелание достаточно точно. Я не буду показывать стиль, который потом развалится на отсутствующей вещи."
      : "Похоже, в каталоге не хватает вещей под выбранный размер, бюджет и категории.",
    "",
    options.length ? "Проверено вариантов: " + options.length + ". Доступных полностью: 0." : undefined,
    lines.length ? "Что не сошлось:" : undefined,
    ...lines,
  ].filter(Boolean).join("\n");
}
function normalizeIdealStyleOptions(
  plan: IdealOutfitPlan,
  preferences: IdealOutfitPreferences,
): IdealOutfitOption[] {
  const options = plan.options.length
    ? plan.options
    : plan.categories.length
      ? [
          {
            styleName: plan.styleName,
            summary: plan.summary,
            targetGender: plan.targetGender,
            userWish: plan.userWish ?? preferences.userWish,
            sizePreference: plan.sizePreference ?? preferences.sizePreference,
            pricePreference: plan.pricePreference ?? preferences.pricePreference,
            categories: plan.categories,
          },
        ]
      : [];

  return options
    .filter((option) => option.categories.length > 0)
    .slice(0, 3)
    .map((option) => {
      const targetGender = option.targetGender ?? plan.targetGender;
      const userWish = option.userWish ?? plan.userWish ?? preferences.userWish;
      const sizePreference = option.sizePreference ?? plan.sizePreference ?? preferences.sizePreference;
      const pricePreference = option.pricePreference ?? plan.pricePreference ?? preferences.pricePreference;

      return {
        ...option,
        targetGender,
        userWish,
        sizePreference,
        pricePreference,
        categories: option.categories.map((category) => ({
          ...category,
          gender: category.gender ?? targetGender,
          userWish: category.userWish ?? userWish,
          sizePreference: category.sizePreference ?? sizePreference,
          pricePreference: category.pricePreference ?? pricePreference,
        })),
      };
    });
}

function renderIdealStyleOptionsMessage(
  options: IdealOutfitOption[],
  originalCount = options.length,
): string {
  const header = options.length < originalCount
    ? "Фото подходит. Показываю только варианты, которые реально собираются из каталога:"
    : "Фото подходит. Выберите один из доступных вариантов стиля:";

  return [
    header,
    "",
    ...options.map((option, index) => {
      const categories = option.categories.map((entry) => entry.category).join(", ");

      return [
        "**" + (index + 1) + ". " + (option.styleName ?? "Вариант " + (index + 1)) + "**",
        option.summary,
        categories ? "Вещи: " + categories : undefined,
      ].filter(Boolean).join("\n");
    }),
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
  const styleName = option.styleName?.trim() || "Вариант " + (index + 1);

  return ((index + 1) + ". " + styleName).slice(0, 64);
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
  const userWish = request.userWish?.replace(/\s+/g, " ").trim().slice(0, 80);
  const details = [
    userWish ? "учтено пожелание: " + userWish : undefined,
    request.color ? "цвет: " + request.color : undefined,
    matchedTags.length ? "совпали теги: " + matchedTags.slice(0, 4).join(", ") : undefined,
  ].filter(Boolean);

  return details.length
    ? "Лучший кандидат локального каталога, " + details.join("; ") + "."
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
    item.description,
    item.gender,
    ...item.sizes,
    ...item.colors,
    ...item.tags,
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
  if (!item.price) {
    return undefined;
  }

  const amount = item.price.amount;
  const currency = item.price.currency.toUpperCase();
  const formatted = currency === "RUB"
    ? Math.round(amount).toLocaleString("ru-RU") + " ₽"
    : amount.toLocaleString("ru-RU") + " " + item.price.currency;

  if (!item.price.oldAmount || item.price.oldAmount <= amount) {
    return "Цена: " + formatted;
  }

  const oldFormatted = currency === "RUB"
    ? Math.round(item.price.oldAmount).toLocaleString("ru-RU") + " ₽"
    : item.price.oldAmount.toLocaleString("ru-RU") + " " + item.price.currency;

  return "Цена: " + formatted + " вместо " + oldFormatted;
}

function labelForGender(gender: GarmentCatalogItem["gender"]): string {
  if (gender === "male") {
    return "Мужское";
  }

  if (gender === "female") {
    return "Женское";
  }

  return "Унисекс";
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
    return "Сервис анализа сейчас не настроен. Проверьте ключ анализа в `.env`.";
  }

  if (error.message.includes("PRUNA_API_KEY")) {
    return "Реальная примерка сейчас не настроена. Проверьте ключ примерки в `.env` или включите тестовый режим.";
  }

  if (error.message.includes("Monolith catalog is empty")) {
    return "Локальный каталог пуст. Запустите `npm run dev:catalog` или TSUM ingest из папки `monolith/`.";
  }

  if (error.message.toLowerCase().includes("playwright")) {
    return "Для чтения каталога нужен Playwright Chromium. Запустите `npm run playwright:install`, затем обновите каталог.";
  }

  if (error.name === "AbortError") {
    return "Внешний API не ответил вовремя. Попробуйте еще раз чуть позже.";
  }

  return fallback;
}
