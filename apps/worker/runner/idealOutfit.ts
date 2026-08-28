import type {
  GarmentCatalogCategory,
  GarmentCatalogItem,
  StorageObjectRef,
  TryOnJobResult,
  TryOnModelProvider,
  WorkerJobRequest,
} from "../../shared/contracts/index.js";
import { createLogger } from "../../shared/logger.js";
import type { CoordinatorClient } from "../api/coordinatorClient.js";
import type { WorkerConfig } from "../config/index.js";
import { runSelectedTryOnModel } from "../models/index.js";
import {
  isRecord,
  selectInputFile,
  TryOnModelError,
} from "../models/providerUtils.js";

const logger = createLogger("worker");
const candidatesPerCategory = 5;
const maxOutfitSlots = 4;

interface IdealPhotoAnalysis {
  accepted?: boolean;
  reason?: string;
  bodyVisible?: boolean;
  legsVisible?: boolean;
  styleProfile?: string;
  tags?: string[];
}

interface IdealOutfitSlot {
  slot?: string;
  category?: string;
  query?: string;
  tags?: string[];
  optional?: boolean;
}

interface IdealOutfitPlan {
  title?: string;
  summary?: string;
  slots?: IdealOutfitSlot[];
}

interface CandidateGroup {
  slot: Required<Pick<IdealOutfitSlot, "slot" | "category">> & IdealOutfitSlot;
  candidates: GarmentCatalogItem[];
}

interface CandidateRef {
  id: string;
  group: CandidateGroup;
  item: GarmentCatalogItem;
}

interface IdealOutfitSelection {
  title?: string;
  summary?: string;
  selected?: Array<{
    slot?: string;
    itemId?: string;
    cacheKey?: string;
    reason?: string;
  }>;
}

export async function runIdealOutfitJob(params: {
  job: WorkerJobRequest;
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  signal?: AbortSignal;
}): Promise<TryOnJobResult> {
  const { job, config, coordinator, signal } = params;
  const personRef = selectInputFile(job, config.tryOnPersonImageIndex, "person");

  logger.info("Ideal outfit photo validation started", {
    jobId: job.jobId,
  });
  const photoAnalysis = await analyzeIdealPhoto(job, config, coordinator, signal);

  if (!photoAnalysis.accepted) {
    const message =
      photoAnalysis.reason?.trim() ||
      "Фото не подходит для подбора образа. Пришлите фото реального человека в полный рост или по колено, лицо и корпус должны быть видны.";

    logger.info("Ideal outfit photo rejected", {
      jobId: job.jobId,
      reason: message,
    });

    return {
      message,
      nextInput: {
        type: "photo",
        message,
      },
    };
  }

  logger.info("Ideal outfit catalog categories requested", {
    jobId: job.jobId,
  });
  const categories = (await coordinator.listGarmentCatalogCategories()).categories;

  if (categories.length === 0) {
    return {
      message:
        "В storage пока нет вещей для подбора образа. Загрузите garment-item записи с категориями, тегами, ценой, магазином и clean image на белом фоне.",
    };
  }

  const plan = await createIdealOutfitPlan({
    job,
    config,
    coordinator,
    photoAnalysis,
    categories,
    signal,
  });
  const groups = await searchCandidatesForPlan({
    coordinator,
    plan,
    photoAnalysis,
  });

  if (groups.length === 0) {
    return {
      message:
        "Я принял фото, но в storage не нашлось подходящих вещей под выбранные категории и теги. Пополните каталог garment-item или расширьте теги вещей.",
    };
  }

  const selected = await selectBestGarments({
    job,
    config,
    coordinator,
    plan,
    groups,
    signal,
  });

  if (selected.length === 0) {
    return {
      message:
        "Каталог вещей найден, но не получилось выбрать надежный комплект. Попробуйте добавить больше тегов к garment-item записям или загрузить больше clean image вариантов.",
    };
  }

  logger.info("Ideal outfit Pruna try-on started", {
    jobId: job.jobId,
    garments: selected.length,
  });
  const tryOnJob = createTryOnJob(job, personRef, selected);
  const tryOnResult = await runSelectedTryOnModel({
    job: tryOnJob,
    config,
    coordinator,
    signal,
  });

  return {
    message: buildResultMessage(plan, selected),
    files: tryOnResult.files,
    garments: selected,
  };
}

async function analyzeIdealPhoto(
  job: WorkerJobRequest,
  config: WorkerConfig,
  coordinator: CoordinatorClient,
  signal?: AbortSignal,
): Promise<IdealPhotoAnalysis> {
  const text = await runOpenAiText({
    job,
    config,
    coordinator,
    signal,
    prompt: [
      "Ты проверяешь фото для сервиса подбора образа и virtual try-on.",
      "Верни только JSON без markdown.",
      "Схема: {\"accepted\": boolean, \"reason\": string, \"bodyVisible\": boolean, \"legsVisible\": boolean, \"styleProfile\": string, \"tags\": string[] }.",
      "accepted=true только если на фото реальный человек, видны лицо и корпус, поза пригодна для примерки одежды. Полный рост желателен, но ноги и обувь могут быть не видны.",
      "Если ног/обуви не видно, accepted может быть true, но legsVisible=false.",
      "Если это рисунок, рендер, мем, скриншот, лицо не видно, человек со спины, фото слишком темное или нет человека, accepted=false и reason по-русски попросит прислать новое фото.",
      "Не устанавливай личность и не делай выводы о чувствительных признаках.",
    ].join("\n"),
    maxOutputTokens: 450,
  });

  return parseJsonObject<IdealPhotoAnalysis>(text) ?? {
    accepted: false,
    reason:
      "Не получилось надежно проверить фото. Пришлите четкое фото реального человека, где видны лицо и корпус.",
  };
}

async function createIdealOutfitPlan(params: {
  job: WorkerJobRequest;
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  photoAnalysis: IdealPhotoAnalysis;
  categories: GarmentCatalogCategory[];
  signal?: AbortSignal;
}): Promise<IdealOutfitPlan> {
  const categoryList = params.categories
    .map((category) => `${category.name} (${category.count})`)
    .join(", ");
  const text = await runOpenAiText({
    job: params.job,
    config: params.config,
    coordinator: params.coordinator,
    signal: params.signal,
    prompt: [
      "Ты стилист. По фото пользователя и доступным категориям вещей выбери один цельный образ.",
      "Верни только JSON без markdown.",
      "Схема: {\"title\": string, \"summary\": string, \"slots\": [{\"slot\": string, \"category\": string, \"query\": string, \"tags\": string[], \"optional\": boolean}]}.",
      `Доступные категории: ${categoryList}.`,
      `Предварительный профиль: ${params.photoAnalysis.styleProfile ?? "не указан"}.`,
      `Ноги/обувь видны: ${params.photoAnalysis.legsVisible === false ? "нет" : "да"}.`,
      "Выбирай 2-4 слота. Категории пиши строго из списка доступных категорий. Не добавляй обувь, если legsVisible=false.",
      "Не выбирай две вещи одной роли: например два худи, две куртки или двое брюк в один образ.",
      "query и tags должны помогать найти вещь по цвету, фасону, стилю и материалу.",
    ].join("\n"),
    maxOutputTokens: 800,
  });
  const parsed = parseJsonObject<IdealOutfitPlan>(text);

  if (parsed?.slots?.length) {
    return {
      title: parsed.title?.trim() || "Идеальный образ",
      summary: parsed.summary?.trim() || "Подобрал спокойный комплект под внешность и фото.",
      slots: parsed.slots,
    };
  }

  return fallbackPlan(params.categories, params.photoAnalysis);
}

async function searchCandidatesForPlan(params: {
  coordinator: CoordinatorClient;
  plan: IdealOutfitPlan;
  photoAnalysis: IdealPhotoAnalysis;
}): Promise<CandidateGroup[]> {
  const slots = normalizeSlots(params.plan, params.photoAnalysis);
  const groups: CandidateGroup[] = [];

  for (const slot of slots) {
    const firstPass = await params.coordinator.searchGarmentCatalog({
      categories: [slot.category],
      tags: slot.tags,
      text: [slot.category, slot.query, ...(slot.tags ?? [])].join(" "),
      limit: candidatesPerCategory,
    });
    const candidates = firstPass.items.length > 0
      ? firstPass.items
      : (await params.coordinator.searchGarmentCatalog({
          tags: slot.tags,
          text: [slot.category, slot.query, ...(slot.tags ?? [])].join(" "),
          limit: candidatesPerCategory,
        })).items;

    if (candidates.length > 0) {
      groups.push({
        slot,
        candidates: candidates.slice(0, candidatesPerCategory),
      });
    }
  }

  return groups;
}

async function selectBestGarments(params: {
  job: WorkerJobRequest;
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  plan: IdealOutfitPlan;
  groups: CandidateGroup[];
  signal?: AbortSignal;
}): Promise<GarmentCatalogItem[]> {
  const refs = buildCandidateRefs(params.groups).filter((ref) => ref.item.imageUrl);

  if (refs.length === 0) {
    return [];
  }

  const prompt = [
    "Ты выбираешь вещи для одного цельного образа по фото пользователя.",
    "Первое изображение - пользователь. Дальше идут изображения товаров в порядке списка candidates.",
    "Верни только JSON без markdown.",
    "Схема: {\"title\": string, \"summary\": string, \"selected\": [{\"slot\": string, \"itemId\": string, \"reason\": string}]}.",
    "Выбери максимум одну вещь на slot. Не выбирай две вещи одной роли. Выбирай только вещи, которые визуально подходят пользователю и друг другу.",
    `План образа: ${JSON.stringify(params.plan)}`,
    `Candidates: ${JSON.stringify(refs.map((ref, index) => ({
      imageIndex: index + 2,
      itemId: ref.id,
      slot: ref.group.slot.slot,
      category: ref.item.category,
      title: ref.item.title,
      description: ref.item.description,
      tags: ref.item.tags,
      price: ref.item.price,
      store: ref.item.store,
    })))}`,
  ].join("\n");
  const text = await runOpenAiText({
    job: params.job,
    config: params.config,
    coordinator: params.coordinator,
    signal: params.signal,
    prompt,
    inputImageUrls: refs.map((ref) => ref.item.imageUrl as string),
    maxOutputTokens: 900,
  });
  const parsed = parseJsonObject<IdealOutfitSelection>(text);
  const selectedIds = new Set(
    (parsed?.selected ?? [])
      .map((item) => item.itemId ?? item.cacheKey)
      .filter((value): value is string => Boolean(value)),
  );
  const selected = refs
    .filter((ref) => selectedIds.has(ref.id) || selectedIds.has(ref.item.cacheKey))
    .map((ref) => ref.item);

  if (selected.length > 0) {
    return uniqueGarmentsByRole(selected).slice(0, maxOutfitSlots);
  }

  return params.groups
    .map((group) => group.candidates.find((item) => item.imageUrl))
    .filter((item): item is GarmentCatalogItem => Boolean(item))
    .slice(0, maxOutfitSlots);
}

async function runOpenAiText(params: {
  job: WorkerJobRequest;
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  prompt: string;
  inputImageUrls?: string[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await runSelectedTryOnModel({
    job: {
      ...params.job,
      payload: {
        ...params.job.payload,
        text: params.prompt,
        model: {
          provider: "openai",
          task: "appearance-analysis",
          options: {
            imageDetail: "high",
            textVerbosity: "low",
            reasoningEffort: "low",
            reasoningMode: "standard",
            maxOutputTokens: params.maxOutputTokens,
            store: false,
            toolChoice: "none",
            ...(params.inputImageUrls?.length
              ? {
                  inputImageUrls: params.inputImageUrls,
                  maxInputImageUrls: params.inputImageUrls.length,
                }
              : {}),
          },
        },
      },
    },
    config: params.config,
    coordinator: params.coordinator,
    signal: params.signal,
  });

  return stripOpenAiResultPrefix(result.message);
}

function createTryOnJob(
  job: WorkerJobRequest,
  personRef: StorageObjectRef,
  garments: GarmentCatalogItem[],
): WorkerJobRequest {
  const garmentRefs = garments.map((item) => ({
    ...item.image,
    url: item.imageUrl ?? item.image.url,
  }));
  const inputFiles = [personRef, ...garmentRefs];

  return {
    ...job,
    payload: {
      ...job.payload,
      text: "Примерь выбранный цельный образ на пользователя, сохрани лицо, позу, пропорции и фон исходного фото. Используй все изображения одежды как элементы одного комплекта.",
      inputFiles,
      model: {
        provider: readTryOnProvider(job),
        task: "try-on",
        options: {
          garmentFileIndexes: garments.map((_, index) => index + 1),
        },
      },
    },
  };
}

function readTryOnProvider(job: WorkerJobRequest): TryOnModelProvider {
  const options = isRecord(job.payload.model?.options) ? job.payload.model.options : {};
  const value = options.tryOnProvider;

  return value === "mock" || value === "pruna" ? value : "pruna";
}

function normalizeSlots(
  plan: IdealOutfitPlan,
  analysis: IdealPhotoAnalysis,
): Array<Required<Pick<IdealOutfitSlot, "slot" | "category">> & IdealOutfitSlot> {
  return (plan.slots ?? [])
    .map((slot) => ({
      ...slot,
      slot: slot.slot?.trim() || slot.category?.trim() || "item",
      category: slot.category?.trim() || "",
      tags: uniqueStrings(slot.tags ?? []),
    }))
    .filter((slot) => slot.category)
    .filter((slot) => analysis.legsVisible !== false || !isShoeCategory(slot.category))
    .slice(0, maxOutfitSlots);
}

function fallbackPlan(
  categories: GarmentCatalogCategory[],
  analysis: IdealPhotoAnalysis,
): IdealOutfitPlan {
  const preferred = ["футболка", "рубашка", "худи", "брюки", "джинсы", "куртка", "жакет"];
  const categoryNames = categories.map((category) => category.name);
  const slots = preferred
    .map((name) => categoryNames.find((category) => normalizeText(category).includes(normalizeText(name))))
    .filter((category): category is string => Boolean(category))
    .filter((category) => analysis.legsVisible !== false || !isShoeCategory(category))
    .slice(0, 3)
    .map((category) => ({
      slot: category,
      category,
      query: [analysis.styleProfile, ...(analysis.tags ?? [])].filter(Boolean).join(" "),
      tags: analysis.tags ?? [],
    }));

  return {
    title: "Идеальный образ",
    summary: "Подобрал базовый комплект по доступным категориям storage.",
    slots: slots.length ? slots : categoryNames.slice(0, 3).map((category) => ({ slot: category, category })),
  };
}

function buildCandidateRefs(groups: CandidateGroup[]): CandidateRef[] {
  const refs: CandidateRef[] = [];

  for (const group of groups) {
    for (const item of group.candidates) {
      refs.push({
        id: `${group.slot.slot}:${item.cacheKey}`,
        group,
        item,
      });
    }
  }

  return refs;
}

function uniqueGarmentsByRole(items: GarmentCatalogItem[]): GarmentCatalogItem[] {
  const seen = new Set<string>();
  const result: GarmentCatalogItem[] = [];

  for (const item of items) {
    const role = normalizeText(item.category);

    if (seen.has(role)) {
      continue;
    }

    seen.add(role);
    result.push(item);
  }

  return result;
}

function buildResultMessage(
  plan: IdealOutfitPlan,
  garments: GarmentCatalogItem[],
): string {
  const lines = garments.map((item) => {
    const details = [item.price, item.store].filter(Boolean).join(", ");

    return `- **${item.category}:** ${item.title}${details ? ` (${details})` : ""}`;
  });

  return [
    `**Идеальный образ: ${plan.title ?? "подбор"}**`,
    plan.summary ?? "Подобрал комплект под фото и доступные вещи в storage.",
    "",
    "**Выбранные вещи**",
    ...lines,
    "",
    "Ниже отправлю результат примерки и карточки вещей с кнопками на магазин.",
  ].join("\n");
}

function parseJsonObject<T>(text: string): T | undefined {
  const raw = extractJson(text);

  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.warn("Ideal outfit JSON parse failed", {
      error,
      sample: text.slice(0, 500),
    });
    return undefined;
  }
}

function extractJson(text: string): string | undefined {
  const trimmed = stripOpenAiResultPrefix(text).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();

  if (fenced) {
    return fenced;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return undefined;
}

function stripOpenAiResultPrefix(text: string): string {
  return text.replace(/^Ответ от сервера\. Провайдер: OpenAI\.\s*/i, "").trim();
}

function isShoeCategory(category: string): boolean {
  const normalized = normalizeText(category);

  return ["обув", "ботин", "кроссов", "туфл", "shoe", "sneaker", "boots"].some((part) =>
    normalized.includes(part),
  );
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, "е");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
