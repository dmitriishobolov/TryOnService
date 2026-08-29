import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MonolithConfig } from "../config.js";
import type {
  CatalogCategoryTagHints,
  GarmentCatalogItem,
  GarmentGender,
  OutfitCategoryRequest,
} from "../types.js";

const ignoredHintTags = new Set([
  "цум",
  "tsum",
  "male",
  "female",
  "unisex",
  "мужское",
  "женское",
  "унисекс",
  "clothes",
  "fashion show",
  "fashion_show",
  "best-seller",
  "bestseller",
  "tsumruonly",
  "эксклюзивно в цуме",
]);
const categoryAliasesByCanonical: Record<string, string[]> = {
  "брюки": ["штаны", "чиносы", "чинос", "джоггеры", "джоггер", "pants", "trousers", "slacks", "chinos"],
  "джинсы": ["джинсовые брюки", "denim pants", "jeans"],
  "куртка": ["бомбер", "ветровка", "парка", "пуховик", "джинсовая куртка", "джинсовка", "jacket", "bomber"],
  "пиджак": ["жакет", "блейзер", "blazer", "suit jacket"],
  "рубашка": ["сорочка", "shirt"],
  "футболка": ["t-shirt", "tee", "тиширт"],
  "худи": ["толстовка", "свитшот", "hoodie", "sweatshirt"],
  "свитер": ["джемпер", "пуловер", "sweater", "jumper", "pullover"],
  "кардиган": ["cardigan"],
  "жилет": ["vest"],
  "поло": ["polo"],
  "майка": ["tank top"],
  "шорты": ["shorts"],
  "пальто": ["coat"],
  "плащ": ["тренч", "trench"],
  "обувь": ["кроссовки", "ботинки", "туфли", "лоферы", "кеды", "sneakers", "boots", "shoes", "loafers"],
  "анорак": ["anorak"],
  "дубленка": ["дубленка из овчины", "shearling", "sheepskin coat"],
  "смокинг": ["tuxedo"],
  "носки": ["гольфы", "socks"],
  "нижнее белье": ["боксеры", "брифы", "хипсы", "underwear", "boxers", "briefs"],
  "пижама": ["sleepwear", "pyjama", "pajama"],
  "халат": ["robe"],
  "плавки": ["swim trunks", "swimwear"],
};

const categoryInferenceRules: Array<[RegExp, string]> = [
  [/smoking|tuxedo|смокинг/, "смокинг"],
  [/kostyum|suit|костюм/, "костюм"],
  [/pidzhak|zhaket|blazer|blejzer|пиджак|жакет|блейзер/, "пиджак"],
  [/anorak|анорак/, "анорак"],
  [/dublenk|shearling|sheepskin|дубленк/, "дубленка"],
  [/kurtk|jacket|bomber|ветровк|парка|пуховик|джинсовк|куртк|бомбер/, "куртка"],
  [/palto|coat|пальто/, "пальто"],
  [/plash|trench|плащ|тренч/, "плащ"],
  [/dzhins|jeans|джинс/, "джинсы"],
  [/bryuk|trouser|pants|slacks|chino|чинос|брюк|джоггер|штан/, "брюки"],
  [/rubash|shirt|сорочк|рубаш|bluzy|блуз/, "рубашка"],
  [/futbol|t-shirt|tee|футбол|тиширт/, "футболка"],
  [/longsliv|лонгслив/, "лонгслив"],
  [/hudi|hoodie|sweatshirt|худи|толстов|свитшот/, "худи"],
  [/sviter|sweater|jumper|pullover|джемпер|свитер|пуловер/, "свитер"],
  [/kardigan|cardigan|кардиган/, "кардиган"],
  [/zhilet|vest|жилет/, "жилет"],
  [/polo|поло/, "поло"],
  [/mayk|tank top|майк/, "майка"],
  [/top|топ/, "топ"],
  [/short|шорт/, "шорты"],
  [/yubk|skirt|юбк/, "юбка"],
  [/plat|dress|плать/, "платье"],
  [/nosk|socks|гольф|носок|носки/, "носки"],
  [/bokser|brief|underwear|боксер|бриф|хипс/, "нижнее белье"],
  [/pizham|pyjama|pajama|sleepwear|пижам/, "пижама"],
  [/halat|robe|халат/, "халат"],
  [/plavk|swim trunks|swimwear|плавк/, "плавки"],
  [/obuv|shoes|sneaker|boot|туфл|кроссов|ботин|лофер|кед/, "обувь"],
];

const canonicalCategoryNames = new Set(Object.keys(categoryAliasesByCanonical));

export class LocalCatalogStore {
  private items = new Map<string, GarmentCatalogItem>();
  private loaded = false;

  constructor(private readonly config: MonolithConfig) {}

  async load(): Promise<GarmentCatalogItem[]> {
    if (this.loaded) {
      return this.list();
    }

    this.loaded = true;

    if (!existsSync(this.config.catalog.cachePath)) {
      return [];
    }

    const raw = await readFile(this.config.catalog.cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error("Monolith catalog cache must contain an array");
    }

    this.items = new Map(
      parsed
        .filter(isCatalogItem)
        .map(normalizeCatalogItem)
        .map((item) => [item.id, item]),
    );

    return this.list();
  }

  async upsertMany(items: GarmentCatalogItem[]): Promise<GarmentCatalogItem[]> {
    await this.load();

    for (const item of items) {
      const existing = this.items.get(item.id);
      this.items.set(item.id, normalizeCatalogItem({
        ...existing,
        ...item,
        imageContentType: item.imageContentType ?? existing?.imageContentType,
        localImagePath: item.localImagePath ?? existing?.localImagePath,
        updatedAt: new Date().toISOString(),
      }));
    }

    await this.save();

    return this.list();
  }

  async replaceAll(items: GarmentCatalogItem[]): Promise<GarmentCatalogItem[]> {
    await this.load();
    this.items = new Map(
      items
        .map(normalizeCatalogItem)
        .map((item) => [item.id, item]),
    );
    await this.save();

    return this.list();
  }

  async updateItem(item: GarmentCatalogItem): Promise<void> {
    await this.load();
    this.items.set(item.id, normalizeCatalogItem({
      ...item,
      updatedAt: new Date().toISOString(),
    }));
    await this.save();
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.config.catalog.cachePath), { recursive: true });
    await writeFile(
      this.config.catalog.cachePath,
      `${JSON.stringify(this.list(), null, 2)}\n`,
    );
  }

  list(): GarmentCatalogItem[] {
    return [...this.items.values()].sort((a, b) =>
      a.title.localeCompare(b.title, "ru"),
    );
  }

  categories(): string[] {
    return uniqueStrings(this.list().map((item) => item.category));
  }

  categoryTagHints(limitPerField = Number.MAX_SAFE_INTEGER): CatalogCategoryTagHints[] {
    const grouped = new Map<string, GarmentCatalogItem[]>();

    for (const item of this.list()) {
      const bucket = grouped.get(item.category) ?? [];
      bucket.push(item);
      grouped.set(item.category, bucket);
    }

    return [...grouped.entries()]
      .map(([category, items]) => ({
        category,
        aliases: aliasesForCategory(category),
        itemCount: items.length,
        colors: topValues(items.flatMap((item) => item.colorTags), limitPerField),
        styles: topValues(
          items.flatMap((item) => item.styleTags.filter(isUsefulTaxonomyHint)),
          limitPerField,
        ),
        materials: topValues(
          items.flatMap((item) => item.materialTags.filter(isUsefulTaxonomyHint)),
          limitPerField,
        ),
        tags: topValues(
          items.flatMap((item) => item.tags.filter((tag) => isUsefulHintTag(tag, item))),
          limitPerField,
        ),
      }))
      .sort((a, b) => b.itemCount - a.itemCount || a.category.localeCompare(b.category, "ru"));
  }

  getById(id: string): GarmentCatalogItem | undefined {
    return this.items.get(id);
  }

  findCandidates(
    request: OutfitCategoryRequest,
    limit: number,
  ): GarmentCatalogItem[] {
    const normalizedRequest = normalizeOutfitRequest(request);
    const queryWords = tokenize([
      normalizedRequest.category,
      normalizedRequest.query,
      normalizedRequest.color,
      normalizedRequest.notes,
      ...(normalizedRequest.requiredTags ?? []),
      ...(normalizedRequest.preferredTags ?? []),
    ].filter(Boolean).join(" "));
    const scored = this.list()
      .map((item) => ({
        item,
        score: scoreCatalogItem(item, normalizedRequest, queryWords),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "ru"));

    return scored.slice(0, limit).map((entry) => entry.item);
  }
}

function scoreCatalogItem(
  item: GarmentCatalogItem,
  request: OutfitCategoryRequest,
  queryWords: string[],
): number {
  const haystackParts = [
    item.category,
    item.title,
    item.description,
    item.store,
    item.brand,
    item.gender,
    item.genderLabel,
    ...item.tags,
    ...item.colorTags,
    ...item.styleTags,
    ...item.materialTags,
  ].filter(Boolean).join(" ");
  const haystackText = normalizeText(haystackParts);
  const haystackWords = new Set(tokenize(haystackParts));
  const category = normalizeText(request.category);
  const itemCategory = normalizeText(item.category);
  let score = 0;

  if (itemCategory === category) {
    score += 90;
  } else if (itemCategory.includes(category) || category.includes(itemCategory)) {
    score += 45;
  }

  const avoidMatches = countTagMatches(request.avoidTags, haystackText, haystackWords);

  if (avoidMatches > 0) {
    score -= 80 * avoidMatches;
  }

  const requiredTags = uniqueStrings(request.requiredTags ?? []);
  const requiredMatches = countTagMatches(requiredTags, haystackText, haystackWords);

  if (requiredTags.length > 0) {
    score += requiredMatches * 36;
    score -= Math.max(0, requiredTags.length - requiredMatches) * 8;

    if (requiredMatches === 0) {
      score -= 24;
    }
  }

  score += countTagMatches(request.preferredTags, haystackText, haystackWords) * 16;

  if (request.color && tagMatches(request.color, haystackText, haystackWords)) {
    score += 24;
  }

  for (const word of queryWords) {
    if (haystackWords.has(word) || haystackText.includes(word)) {
      score += 8;
    }
  }

  if (item.localImagePath) {
    score += 12;
  } else if (item.imageUrl) {
    score += 2;
  }

  if (item.productUrl) {
    score += 3;
  }

  return score;
}

function countTagMatches(
  tags: string[] | undefined,
  haystackText: string,
  haystackWords: Set<string>,
): number {
  return uniqueStrings(tags ?? [])
    .filter((tag) => tagMatches(tag, haystackText, haystackWords))
    .length;
}

function tagMatches(tag: string, haystackText: string, haystackWords: Set<string>): boolean {
  const normalized = normalizeText(tag);

  if (!normalized) {
    return false;
  }

  if (haystackText.includes(normalized)) {
    return true;
  }

  const words = tokenize(normalized);

  return words.length > 0 && words.every((word) => haystackWords.has(word));
}

function topValues(values: string[], limit: number): string[] {
  const counts = new Map<string, { value: string; count: number }>();

  for (const value of values) {
    const trimmed = value.trim();

    if (!trimmed) {
      continue;
    }

    const key = normalizeText(trimmed);
    const current = counts.get(key);
    counts.set(key, {
      value: current?.value ?? trimmed,
      count: (current?.count ?? 0) + 1,
    });
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ru"))
    .slice(0, limit)
    .map((entry) => entry.value);
}

function isUsefulTaxonomyHint(tag: string): boolean {
  const normalized = normalizeText(tag);

  return Boolean(
    normalized &&
    !ignoredHintTags.has(normalized) &&
    !/\d/.test(normalized) &&
    !normalized.includes("_")
  );
}

function isUsefulHintTag(tag: string, item: GarmentCatalogItem): boolean {
  const normalized = normalizeText(tag);

  if (
    !normalized ||
    ignoredHintTags.has(normalized) ||
    normalized === normalizeText(item.category) ||
    normalized === normalizeText(item.genderLabel) ||
    normalized === normalizeText(item.brand ?? "") ||
    normalized === normalizeText(item.title) ||
    /\d/.test(normalized) ||
    normalized.includes("-")
  ) {
    return false;
  }

  return normalized.length <= 28;
}

function isCatalogItem(value: unknown): value is GarmentCatalogItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "string" &&
    typeof item.provider === "string" &&
    typeof item.externalId === "string" &&
    typeof item.productUrl === "string" &&
    typeof item.title === "string" &&
    typeof item.category === "string" &&
    typeof item.imageUrl === "string" &&
    Array.isArray(item.tags)
  );
}

function normalizeCatalogItem(item: GarmentCatalogItem): GarmentCatalogItem {
  const gender = normalizeGender(item.gender);
  const genderLabel = item.genderLabel?.trim() || labelForGender(gender);
  const category = normalizeCatalogCategory(item);

  return {
    ...item,
    category,
    gender,
    genderLabel,
    tags: uniqueStrings([
      ...item.tags.filter((tag) => shouldKeepCatalogTag(tag, category)),
      category,
      ...aliasesForCategory(category),
      gender,
      genderLabel.toLowerCase(),
    ]),
    colorTags: uniqueStrings(item.colorTags ?? []),
    styleTags: uniqueStrings(item.styleTags ?? []),
    materialTags: uniqueStrings(item.materialTags ?? []),
  };
}

function normalizeOutfitRequest(request: OutfitCategoryRequest): OutfitCategoryRequest {
  return {
    ...request,
    category: canonicalizeCategoryText(request.category) ?? request.category,
    requiredTags: normalizeRequestTags(request.requiredTags),
    preferredTags: normalizeRequestTags(request.preferredTags),
    avoidTags: normalizeRequestTags(request.avoidTags),
  };
}

function normalizeRequestTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) {
    return undefined;
  }

  return uniqueStrings(tags.map((tag) => canonicalizeCategoryText(tag) ?? tag));
}

function normalizeCatalogCategory(item: GarmentCatalogItem): string {
  const categorySlug = readMetadataString(item.metadata, "categorySlug");

  return (
    canonicalizeCategoryText(categorySlug) ??
    canonicalizeCategoryText(item.category) ??
    canonicalizeCategoryText(item.title) ??
    item.category
  );
}

function aliasesForCategory(category: string): string[] {
  return categoryAliasesByCanonical[normalizeText(category)] ?? [];
}

function shouldKeepCatalogTag(tag: string, category: string): boolean {
  const canonicalTag = canonicalizeExactCategoryTag(tag);

  return !canonicalTag || canonicalTag === normalizeText(category);
}

function canonicalizeExactCategoryTag(tag: string): string | undefined {
  const normalized = normalizeText(tag);

  if (canonicalCategoryNames.has(normalized)) {
    return normalized;
  }

  for (const [category, aliases] of Object.entries(categoryAliasesByCanonical)) {
    if (aliases.some((alias) => normalizeText(alias) === normalized)) {
      return category;
    }
  }

  if (/[-_]\d/.test(normalized) || /\d/.test(normalized)) {
    return canonicalizeCategoryText(normalized);
  }

  return undefined;
}

function canonicalizeCategoryText(value: string | undefined): string | undefined {
  const normalized = normalizeText(value ?? "");

  if (!normalized) {
    return undefined;
  }

  if (canonicalCategoryNames.has(normalized)) {
    return normalized;
  }

  for (const [category, aliases] of Object.entries(categoryAliasesByCanonical)) {
    if (aliases.some((alias) => normalizeText(alias) === normalized)) {
      return category;
    }
  }

  for (const [pattern, category] of categoryInferenceRules) {
    if (pattern.test(normalized)) {
      return category;
    }
  }

  return undefined;
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" && value.trim() ? value : undefined;
}
function normalizeGender(value: unknown): GarmentGender {
  if (value === "male" || value === "female" || value === "unisex") {
    return value;
  }

  return "unisex";
}

function labelForGender(gender: GarmentGender): string {
  if (gender === "male") {
    return "Мужское";
  }

  if (gender === "female") {
    return "Женское";
  }

  return "Унисекс";
}

function tokenize(value: string): string[] {
  return uniqueStrings(
    normalizeText(value)
      .split(/[^a-zа-яё0-9]+/i)
      .filter((word) => word.length > 1),
  );
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, "е");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
