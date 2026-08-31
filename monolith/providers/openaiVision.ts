import { createLogger } from "../utils/logger.js";
import type { MonolithConfig } from "../config.js";
import type {
  CatalogCategoryTagHints,
  GarmentCatalogItem,
  GarmentGender,
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
} from "../types.js";
import { fetchWithTimeout, joinUrl, responseError } from "../utils/http.js";

const logger = createLogger("monolith");

const appearanceAnalysisPrompt = [
  "Ты выполняешь разбор внешности только по фотографии реального человека.",
  "",
  "Сначала проверь изображение:",
  "- это должна быть фотография реального человека, а не рисунок, рендер, аватар, мем, игрушка или скриншот;",
  "- лицо человека должно быть видно достаточно ясно для аккуратного стилевого анализа;",
  "- если лицо закрыто, слишком темно, размыто, человек снят со спины или на фото нет человека, анализ не выполняй.",
  "",
  "Если изображение не подходит, ответь строго этой фразой:",
  '"Вы загрузили не реальное фото или на фото не видно лица. Пожалуйста, отправьте четкую фотографию реального человека с видимым лицом."',
  "",
  "Если изображение подходит, дай конкретный и полезный разбор внешности на русском языке. Ответ должен быть компактным: максимум 1300 символов, без длинного вступления и повторов.",
  "",
  "Стиль ответа:",
  "- пиши живо и естественно, как стилист, который быстро объясняет человеку сильные стороны образа;",
  "- не используй длинное тире, символ U+2014 и похожие длинные тире. Вместо них ставь запятую, двоеточие, точку с запятой или обычный дефис '-';",
  "- избегай канцелярита, шаблонных фраз и слишком общих советов.",
  "",
  "Формат ответа:",
  "**Вывод**",
  "2-3 короткие живые фразы: что считывается во внешности, что стоит подчеркнуть в образе, какая подача будет смотреться естественно.",
  "",
  "**Параметры**",
  "- **Лицо:** форма лица, 1 короткое уточнение.",
  "- **Контраст:** низкий/средний/высокий и что это значит для одежды.",
  "- **Пропорции:** только видимые особенности, без оценочных суждений.",
  "- **Цвета:** 4-6 подходящих оттенков.",
  "- **Избегать:** 3-5 оттенков или сочетаний.",
  "- **Фасоны:** футболки/рубашки/куртки/брюки одной короткой строкой.",
  "- **Аксессуары:** 2-4 варианта.",
  "- **Прическа:** 1-2 практичные рекомендации.",
  "- **Стили:** 3 направления через запятую.",
  "",
  "Не пытайся устанавливать личность человека. Не делай выводы о здоровье, этничности, религии, сексуальности, точном возрасте или других чувствительных признаках. Если освещение мешает точно определить цветотип, явно скажи об этом.",
].join("\n");

export class OpenAiVisionService {
  constructor(private readonly config: MonolithConfig) {}

  async analyzeAppearance(image: ImageData): Promise<string> {
    return this.requestResponsesText({
      operation: "appearance-analysis",
      prompt: appearanceAnalysisPrompt,
      images: [image],
      maxOutputTokens: this.config.openai.maxOutputTokens,
    });
  }

  async planIdealOutfit(
    image: ImageData,
    catalogHints: CatalogCategoryTagHints[],
    preferences: IdealOutfitPreferences,
  ): Promise<IdealOutfitPlan> {
    const text = await this.requestResponsesText({
      operation: "ideal-outfit-plan",
      prompt: buildIdealOutfitPlanPrompt(catalogHints, preferences),
      images: [image],
      maxOutputTokens: Math.max(this.config.openai.maxOutputTokens, 1_400),
    });
    const parsed = parseJsonObject(text);

    return normalizeIdealOutfitPlan(parsed, preferences);
  }

  async chooseOutfitItems(
    plan: IdealOutfitPlan,
    groups: OutfitCandidateGroup[],
  ): Promise<OutfitSelection> {
    const text = await this.requestResponsesText({
      operation: "ideal-outfit-selection",
      prompt: buildOutfitSelectionPrompt(plan, groups),
      images: [],
      maxOutputTokens: 700,
    });
    const parsed = parseJsonObject(text);

    return normalizeOutfitSelection(parsed, plan, groups);
  }

  private async requestResponsesText(params: {
    operation: string;
    prompt: string;
    images: ImageData[];
    maxOutputTokens: number;
  }): Promise<string> {
    const apiKey = this.config.openai.apiKey;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }

    logger.info("OpenAI Responses request started", {
      operation: params.operation,
      model: this.config.openai.model,
      images: params.images.length,
      promptLength: params.prompt.length,
      maxOutputTokens: params.maxOutputTokens,
    });

    const response = await fetchWithTimeout(
      joinUrl(this.config.openai.baseUrl, "/v1/responses"),
      {
        method: "POST",
        headers: this.openAiHeaders(apiKey),
        body: JSON.stringify({
          model: this.config.openai.model,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: this.config.openai.systemPrompt,
                },
              ],
            },
            {
              role: "user",
              content: buildUserContent(
                params.prompt,
                params.images,
                this.config.openai.imageDetail,
              ),
            },
          ],
          text: {
            format: {
              type: "text",
            },
            verbosity: this.config.openai.textVerbosity,
          },
          reasoning: {
            effort: this.config.openai.reasoningEffort,
            ...(this.config.openai.reasoningMode
              ? { mode: this.config.openai.reasoningMode }
              : {}),
          },
          max_output_tokens: params.maxOutputTokens,
          store: this.config.openai.storeResponse,
        }),
      },
      this.config.httpTimeoutMs,
    );

    if (!response.ok) {
      throw await responseError("openai", response);
    }

    const payload = await response.json();
    const outputText = extractOutputText(payload);

    if (!outputText) {
      throw new Error("OpenAI response did not contain output text");
    }

    logger.info("OpenAI Responses request finished", {
      operation: params.operation,
      model: this.config.openai.model,
      outputLength: outputText.length,
    });

    return outputText;
  }

  private openAiHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      ...(this.config.openai.organization
        ? { "OpenAI-Organization": this.config.openai.organization }
        : {}),
      ...(this.config.openai.project
        ? { "OpenAI-Project": this.config.openai.project }
        : {}),
    };
  }
}

function buildUserContent(
  prompt: string,
  images: ImageData[],
  imageDetail: string,
): Array<Record<string, string>> {
  return [
    {
      type: "input_text",
      text: prompt,
    },
    ...images.map((image) => ({
      type: "input_image",
      image_url: toDataUrl(image),
      detail: imageDetail,
    })),
  ];
}

function formatIdealPreferences(preferences: IdealOutfitPreferences): Record<string, string> {
  return {
    userWish: preferences.userWish?.trim() || "не указано, стилист свободен в подборе",
    sizePreference: sizePreferenceLabel(preferences.sizePreference),
    pricePreference: pricePreferenceLabel(preferences.pricePreference),
  };
}

function sizePreferenceLabel(preference: SizePreference): string {
  switch (preference) {
    case "xs-s":
      return "XS-S";
    case "m-l":
      return "M-L";
    case "xl-xxl":
      return "XL-XXL";
    case "any":
      return "любой размер";
  }
}

function pricePreferenceLabel(preference: PricePreference): string {
  switch (preference) {
    case "under-10k":
      return "до 10 000 рублей за вещь";
    case "under-30k":
      return "до 30 000 рублей за вещь";
    case "under-100k":
      return "до 100 000 рублей за вещь";
    case "over-100k":
      return "100 000 рублей и выше за вещь";
    case "any":
      return "любой бюджет";
  }
}

function buildIdealOutfitPlanPrompt(
  catalogHints: CatalogCategoryTagHints[],
  preferences: IdealOutfitPreferences,
): string {
  return [
    "Ты стилист внутри MVP TryOnService.",
    "Это единственный GPT-вызов для проверки фото и плана образа. Не проси дополнительных запросов.",
    "Нужно проверить фото человека и предложить ровно 3 разных варианта стиля. В каждом варианте выбери 2-3 категории одежды из локального каталога.",
    "Фото подходит, если человек виден в полный рост или хотя бы по колено. Обувь/ступни могут быть не видны, тогда не выбирай обувь.",
    "Обязательно определи targetGender: male, female или unisex. Это сегмент локального каталога одежды для подбора вещей, а не вывод о личности человека.",
    "Если фото не подходит, верни JSON с accepted=false и коротким rejectionMessage на русском.",
    "Если пользовательское пожелание нельзя превратить в одежду, оно не про стиль, выглядит как набор случайных символов или небезопасный запрос, верни accepted=false и попроси коротко переформулировать пожелание.",
    "Если пожелание необычное, но применимое, не отказывай. Адаптируй его под реальный носибельный образ и доступный каталог, а причину адаптации коротко упомяни в summary одного или нескольких вариантов.",
    "Если подходит, верни targetGender и options из 3 вариантов. У каждого варианта должен быть свой styleName, summary, targetGender, userWish, sizePreference, pricePreference и categories. У каждой category тоже укажи gender, userWish, sizePreference и pricePreference.",
    "category должен быть ровно одним из catalogHints.c. aliases помогают понять синонимы, но в category возвращай только каноническое catalogHints.c. Теги бери из colors/tags или aliases каталога.",
    "catalogHints.g показывает сколько товаров этой категории есть по полу после выбранных фильтров. После определения targetGender выбирай только категории, где g[targetGender] или g.unisex больше 0.",
    "Если для пола и фильтров нет категории под желаемую идею, адаптируй идею к доступным категориям вместо того, чтобы планировать вещь, которой нет в каталоге.",
    "requiredTags: 0-4 главных признака, которые сильно нужны для вещи: цвет, материал, крой, сезонность или категория.",
    "Если userWish содержит конкретный мотив, рисунок, цвет или материал, добавь это в requiredTags; каталог будет считать такие признаки обязательными.",
    "preferredTags: 2-6 мягких признаков: стиль, посадка, оттенок, настроение образа.",
    "avoidTags: 0-4 признака, которых лучше избегать.",
    "Не указывай бренды как requiredTags. Не выбирай два одинаковых типа вещи. Для низа используй канон каталога, например брюки или джинсы, а не разговорное штаны. Для обычного публичного образа не выбирай нижнее белье, носки, пижаму, халат или плавки, если пользователь явно не просит. Не используй длинное тире.",
    "Не устанавливай личность и не делай выводы о чувствительных признаках.",
    "Учитывай пользовательские ограничения как сильные предпочтения, но если каталог пуст по точному размеру или бюджету, оставь шанс лучшим близким товарам.",
    "",
    "Пожелания пользователя:",
    JSON.stringify(formatIdealPreferences(preferences)),
    "",
    "Hard constraints:",
    "pricePreference is a strict catalog limit. For under-10k, under-30k and under-100k never plan an item above the selected amount.",
    "If the selected budget has too few exact items, choose a broader query or another available category inside that budget instead of planning expensive fallback items.",
    "userWish must visibly influence styleName, summary, query, preferredTags and avoidTags when it is present.",
    "sizePreference is a catalog filter. If it is any, do not restrict sizes; otherwise prefer categories likely to have that size.",
    "",
    "catalogHints JSON:",
    JSON.stringify(serializeCatalogHints(catalogHints)),
    "",
    "Верни только JSON без markdown:",
    JSON.stringify({
      accepted: true,
      targetGender: "male",
      userWish: preferences.userWish ?? undefined,
      sizePreference: preferences.sizePreference,
      pricePreference: preferences.pricePreference,
      options: [
        {
          styleName: "спокойный smart casual",
          targetGender: "male",
          userWish: preferences.userWish ?? undefined,
          sizePreference: preferences.sizePreference,
          pricePreference: preferences.pricePreference,
          summary: "мягкий собранный образ на каждый день с учетом пожелания и бюджета",
          categories: [
            {
              category: "рубашка",
              gender: "male",
              query: "голубая хлопковая рубашка прямого кроя",
              color: "голубой",
              userWish: preferences.userWish ?? undefined,
              sizePreference: preferences.sizePreference,
              pricePreference: preferences.pricePreference,
              requiredTags: ["рубашка", "голубой"],
              preferredTags: ["хлопок", "прямой крой", "smart casual"],
              avoidTags: ["яркий принт"],
            },
            {
              category: "брюки",
              gender: "male",
              query: "темно-синие прямые брюки",
              color: "темно-синий",
              userWish: preferences.userWish ?? undefined,
              sizePreference: preferences.sizePreference,
              pricePreference: preferences.pricePreference,
              requiredTags: ["брюки", "темно-синий"],
              preferredTags: ["прямой крой", "smart casual"],
              avoidTags: [],
            },
          ],
        },
        {
          styleName: "городской минимализм",
          targetGender: "male",
          userWish: preferences.userWish ?? undefined,
          sizePreference: preferences.sizePreference,
          pricePreference: preferences.pricePreference,
          summary: "лаконичный контрастный образ с чистыми линиями",
          categories: [
            {
              category: "куртка",
              gender: "male",
              query: "черная лаконичная куртка",
              color: "черный",
              userWish: preferences.userWish ?? undefined,
              sizePreference: preferences.sizePreference,
              pricePreference: preferences.pricePreference,
              requiredTags: ["куртка", "черный"],
              preferredTags: ["минимализм"],
              avoidTags: ["крупный логотип"],
            },
          ],
        },
        {
          styleName: "расслабленный casual",
          targetGender: "male",
          userWish: preferences.userWish ?? undefined,
          sizePreference: preferences.sizePreference,
          pricePreference: preferences.pricePreference,
          summary: "более мягкая посадка и спокойная палитра",
          categories: [
            {
              category: "футболка",
              gender: "male",
              query: "белая плотная футболка прямого кроя",
              color: "белый",
              userWish: preferences.userWish ?? undefined,
              sizePreference: preferences.sizePreference,
              pricePreference: preferences.pricePreference,
              requiredTags: ["футболка", "белый"],
              preferredTags: ["хлопок", "casual"],
              avoidTags: ["яркий принт"],
            },
          ],
        },
      ],
    }),
  ].join("\n");
}

function buildOutfitSelectionPrompt(
  plan: IdealOutfitPlan,
  groups: OutfitCandidateGroup[],
): string {
  return [
    "Выбери лучшие реальные товары из локального каталога под уже выбранный стиль.",
    "Это второй и последний GPT-вызов в сценарии, поэтому выбери из доступных кандидатов без дополнительных уточнений.",
    "На каждую категорию выбери максимум один товар. Не выбирай два одинаковых типа вещи в один образ.",
    "Учитывай request.requiredTags, request.preferredTags и request.avoidTags. Если кандидаты слабые, всё равно выбери лучший из доступных, это MVP.",
    "Верни только JSON без markdown: {\"styleName\":\"...\",\"summary\":\"...\",\"items\":[{\"category\":\"...\",\"itemId\":\"...\",\"reason\":\"...\"}]}",
    "",
    "План:",
    JSON.stringify(plan),
    "",
    "Hard constraints for selection: never choose an item that violates request.pricePreference or request.sizePreference. userWish must influence the reason when present.",
    "",
    "Кандидаты:",
    JSON.stringify(groups.map(serializeCandidateGroup)),
  ].join("\n");
}

function serializeCatalogHints(hints: CatalogCategoryTagHints[]): unknown[] {
  return hints.map((hint) => ({
    c: hint.category,
    aliases: hint.aliases,
    n: hint.itemCount,
    g: hint.genderCounts,
    colors: hint.colors,
    tags: hint.tags,
  }));
}
function serializeCandidateGroup(group: OutfitCandidateGroup): unknown {
  return {
    request: group.request,
    candidates: group.candidates.map(serializeCatalogItem),
  };
}

function serializeCatalogItem(item: GarmentCatalogItem): unknown {
  return {
    id: item.id,
    category: item.category,
    gender: item.gender,
    title: item.title,
    description: item.description,
    sizes: item.sizes.slice(0, 12),
    colors: item.colors.slice(0, 8),
    price: item.price,
    tags: item.tags.slice(0, 16),
    productUrl: item.productUrl,
    imageUrl: item.imageUrl,
    hasImageFile: Boolean(item.imageFile),
  };
}

function toDataUrl(image: ImageData): string {
  return "data:" + image.contentType + ";base64," + image.buffer.toString("base64");
}

function extractOutputText(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.output_text === "string") {
    return value.output_text.trim() || undefined;
  }

  return collectText(value).join("\n").trim() || undefined;
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectText);
  }

  if (!isRecord(value)) {
    return [];
  }

  if (
    (value.type === "output_text" || value.type === "text") &&
    typeof value.text === "string"
  ) {
    return [value.text];
  }

  return Object.values(value).flatMap(collectText);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1]?.trim();
  const candidate = fenced ?? trimmed;

  try {
    const parsed = JSON.parse(candidate) as unknown;

    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start >= 0 && end > start) {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;

      if (isRecord(parsed)) {
        return parsed;
      }
    }
  }

  throw new Error("OpenAI response did not contain a JSON object");
}

function sizePreferenceValue(value: unknown): SizePreference | undefined {
  return value === "any" || value === "xs-s" || value === "m-l" || value === "xl-xxl" ? value : undefined;
}

function pricePreferenceValue(value: unknown): PricePreference | undefined {
  return value === "any" || value === "under-10k" || value === "under-30k" || value === "under-100k" || value === "over-100k" ? value : undefined;
}

function normalizeIdealOutfitPlan(
  value: Record<string, unknown>,
  preferences: IdealOutfitPreferences,
): IdealOutfitPlan {
  const accepted = value.accepted === true;
  const targetGender = garmentGenderValue(value.targetGender) ?? garmentGenderValue(value.gender);
  const legacyCategories = Array.isArray(value.categories)
    ? value.categories.flatMap((entry) => normalizeCategoryRequest(entry, targetGender, preferences)).slice(0, 3)
    : [];
  const rawOptions = Array.isArray(value.options)
    ? value.options
    : Array.isArray(value.styles)
      ? value.styles
      : [];
  const normalizedOptions = rawOptions
    .flatMap((option) => normalizeIdealOutfitOption(option, targetGender, preferences))
    .slice(0, 3);
  const fallbackOption = legacyCategories.length
    ? [
        {
          styleName: stringValue(value.styleName),
          summary: stringValue(value.summary),
          targetGender,
          userWish: stringValue(value.userWish) ?? preferences.userWish,
          sizePreference: sizePreferenceValue(value.sizePreference) ?? preferences.sizePreference,
          pricePreference: pricePreferenceValue(value.pricePreference) ?? preferences.pricePreference,
          categories: legacyCategories,
        },
      ]
    : [];
  const options = normalizedOptions.length ? normalizedOptions : fallbackOption;
  const first = options[0];

  return {
    accepted,
    rejectionMessage: stringValue(value.rejectionMessage),
    targetGender: first?.targetGender ?? targetGender,
    userWish: first?.userWish ?? stringValue(value.userWish) ?? preferences.userWish,
    sizePreference: first?.sizePreference ?? sizePreferenceValue(value.sizePreference) ?? preferences.sizePreference,
    pricePreference: first?.pricePreference ?? pricePreferenceValue(value.pricePreference) ?? preferences.pricePreference,
    styleName: first?.styleName ?? stringValue(value.styleName),
    summary: first?.summary ?? stringValue(value.summary),
    categories: first?.categories ?? legacyCategories,
    options,
  };
}

function normalizeIdealOutfitOption(
  value: unknown,
  fallbackGender: GarmentGender | undefined,
  preferences: IdealOutfitPreferences,
): IdealOutfitOption[] {
  if (!isRecord(value)) {
    return [];
  }

  const targetGender = garmentGenderValue(value.targetGender) ?? garmentGenderValue(value.gender) ?? fallbackGender;
  const categories = Array.isArray(value.categories)
    ? value.categories.flatMap((entry) => normalizeCategoryRequest(entry, targetGender, preferences)).slice(0, 3)
    : [];

  if (categories.length === 0) {
    return [];
  }

  return [
    {
      styleName: stringValue(value.styleName),
      summary: stringValue(value.summary),
      targetGender,
      userWish: stringValue(value.userWish) ?? preferences.userWish,
      sizePreference: sizePreferenceValue(value.sizePreference) ?? preferences.sizePreference,
      pricePreference: pricePreferenceValue(value.pricePreference) ?? preferences.pricePreference,
      categories,
    },
  ];
}

function normalizeCategoryRequest(
  value: unknown,
  fallbackGender: GarmentGender | undefined,
  preferences: IdealOutfitPreferences,
): OutfitCategoryRequest[] {
  if (!isRecord(value)) {
    return [];
  }

  const category = stringValue(value.category);
  const query = stringValue(value.query) ?? category;

  if (!category || !query) {
    return [];
  }

  return [
    {
      category,
      query,
      gender: garmentGenderValue(value.gender) ?? garmentGenderValue(value.targetGender) ?? fallbackGender,
      color: stringValue(value.color),
      notes: stringValue(value.notes),
      userWish: stringValue(value.userWish) ?? preferences.userWish,
      sizePreference: sizePreferenceValue(value.sizePreference) ?? preferences.sizePreference,
      pricePreference: pricePreferenceValue(value.pricePreference) ?? preferences.pricePreference,
      requiredTags: stringArrayValue(value.requiredTags).slice(0, 4),
      preferredTags: stringArrayValue(value.preferredTags).slice(0, 8),
      avoidTags: stringArrayValue(value.avoidTags).slice(0, 5),
    },
  ];
}
function normalizeOutfitSelection(
  value: Record<string, unknown>,
  plan: IdealOutfitPlan,
  groups: OutfitCandidateGroup[],
): OutfitSelection {
  const allowedIds = new Set(groups.flatMap((group) => group.candidates.map((item) => item.id)));
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
    .flatMap((item) => normalizeSelectionItem(item, allowedIds))
    .slice(0, 3);

  return {
    styleName: stringValue(value.styleName) ?? plan.styleName ?? "Идеальный образ",
    summary: stringValue(value.summary) ?? plan.summary ?? "Подобрал вещи из локального каталога.",
    items: items.length ? items : fallbackSelection(groups),
  };
}

function normalizeSelectionItem(
  value: unknown,
  allowedIds: Set<string>,
): OutfitSelectionItem[] {
  if (!isRecord(value)) {
    return [];
  }

  const itemId = stringValue(value.itemId);
  const category = stringValue(value.category);

  if (!itemId || !category || !allowedIds.has(itemId)) {
    return [];
  }

  return [
    {
      category,
      itemId,
      reason: stringValue(value.reason),
    },
  ];
}

function fallbackSelection(groups: OutfitCandidateGroup[]): OutfitSelectionItem[] {
  return groups.flatMap((group) => {
    const first = group.candidates[0];

    return first
      ? [
          {
            category: group.request.category,
            itemId: first.id,
            reason: "Лучший кандидат по локальному скорингу.",
          },
        ]
      : [];
  }).slice(0, 3);
}

function garmentGenderValue(value: unknown): GarmentGender | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "male" || normalized === "мужское" || normalized === "men" || normalized === "man") {
    return "male";
  }

  if (normalized === "female" || normalized === "женское" || normalized === "women" || normalized === "woman") {
    return "female";
  }

  if (normalized === "unisex" || normalized === "унисекс") {
    return "unisex";
  }

  return undefined;
}
function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((item) => typeof item === "string" ? [item] : []));
  }

  if (typeof value === "string") {
    return uniqueStrings(value.split(","));
  }

  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
