import { chromium, type Page } from "playwright";

import type { MonolithConfig } from "../../../config.js";
import type { GarmentCatalogItem, GarmentGender } from "../../../types.js";
import { fetchWithTimeout, readResponseBuffer, sleep } from "../../../utils/http.js";
import { createLogger } from "../../../utils/logger.js";

const logger = createLogger("monolith");

type JsonObject = Record<string, unknown>;

const TSUM_PRODUCT_IMAGE_FIELDS = [
  "large",
  "w1320",
  "w1320x2",
  "middle",
  "w600",
  "w600x2",
  "small",
  "w320",
  "w320x2",
  "w200",
  "w200x2",
  "tiny",
  "w100",
  "w100x2",
] as const;

export interface TsumCatalogParseOptions {
  gender?: GarmentGender;
}

export interface TsumCatalogWalkOptions extends TsumCatalogParseOptions {
  startPage?: number;
  stopOnPageError?: boolean;
  onPage?: (batch: TsumCatalogPageBatch) => Promise<void> | void;
}

export interface TsumCatalogPageBatch {
  sourceUrl: string;
  pageUrl: string;
  pageNumber: number;
  pageLimit: number;
  discoveredPages: number;
  total?: number;
  perPage?: number;
  status?: number;
  items: GarmentCatalogItem[];
}

interface TsumCatalogPage {
  url: string;
  title: string;
  status?: number;
  products: JsonObject[];
  pageCount?: number;
  currentPage?: number;
  perPage?: number;
  total?: number;
}

export async function parseTsumCatalogUrl(
  url: string,
  config: MonolithConfig,
  options: TsumCatalogParseOptions = {},
): Promise<GarmentCatalogItem[]> {
  return walkTsumCatalogUrl(url, config, options);
}

export async function walkTsumCatalogUrl(
  url: string,
  config: MonolithConfig,
  options: TsumCatalogWalkOptions = {},
): Promise<GarmentCatalogItem[]> {
  const gender = options.gender ?? "unisex";
  const startPage = Math.max(1, Math.floor(options.startPage ?? 1));

  logger.info("Monolith TSUM catalog read started", { url, gender, startPage });

  const browser = await chromium.launch({
    headless: config.catalog.browserHeadless,
  });

  try {
    const page = await browser.newPage({
      userAgent: config.catalog.userAgent,
    });
    const byId = new Map<string, GarmentCatalogItem>();
    const firstPage = await readTsumCatalogPageWithRetries(page, pageUrlFor(url, 1), config, 1);

    const discoveredPages = Math.max(1, firstPage.pageCount ?? 1);
    const pageLimit = config.catalog.tsumMaxPages > 0
      ? Math.min(discoveredPages, config.catalog.tsumMaxPages)
      : discoveredPages;
    const itemLimit = config.catalog.batchSize;
    let emittedItems = 0;

    logger.info("Monolith TSUM catalog first page parsed", {
      url,
      title: firstPage.title,
      status: firstPage.status,
      gender,
      discoveredPages,
      pageLimit,
      perPage: firstPage.perPage,
      total: firstPage.total,
      products: firstPage.products.length,
    });

    const emitPage = async (
      catalogPage: TsumCatalogPage,
      pageNumber: number,
    ): Promise<void> => {
      const normalized = catalogPage.products.flatMap((product) =>
        normalizeTsumProduct(product, catalogPage.url, gender),
      );
      const remaining = itemLimit > 0 ? Math.max(0, itemLimit - emittedItems) : normalized.length;
      const items = itemLimit > 0 ? normalized.slice(0, remaining) : normalized;

      emittedItems += items.length;

      for (const item of items) {
        if (!byId.has(item.id)) {
          byId.set(item.id, item);
        }
      }

      if (options.onPage) {
        await options.onPage({
          sourceUrl: url,
          pageUrl: catalogPage.url,
          pageNumber,
          pageLimit,
          discoveredPages,
          total: catalogPage.total,
          perPage: catalogPage.perPage,
          status: catalogPage.status,
          items,
        });
      }
    };

    if (startPage <= 1) {
      await emitPage(firstPage, 1);
    }

    if (startPage > pageLimit) {
      logger.info("Monolith TSUM catalog source already completed by checkpoint", {
        url,
        gender,
        startPage,
        pageLimit,
      });
      return [...byId.values()];
    }

    for (let pageNumber = Math.max(2, startPage); pageNumber <= pageLimit; pageNumber += 1) {
      if (itemLimit > 0 && emittedItems >= itemLimit) {
        break;
      }

      if (config.catalog.tsumPageDelayMs > 0) {
        await sleep(config.catalog.tsumPageDelayMs);
      }

      const currentUrl = pageUrlFor(url, pageNumber);

      try {
        const currentPage = await readTsumCatalogPageWithRetries(page, currentUrl, config, pageNumber);
        await emitPage(currentPage, pageNumber);

        if (
          pageNumber % config.catalog.tsumProgressLogEveryPages === 0 ||
          pageNumber === pageLimit
        ) {
          logger.info("Monolith TSUM catalog parse progress", {
            url,
            gender,
            page: pageNumber,
            pageLimit,
            items: byId.size,
          });
        }
      } catch (error) {
        logger.warn("Monolith TSUM catalog page parse failed", {
          url: currentUrl,
          page: pageNumber,
          error: errorMessage(error),
        });

        if (options.stopOnPageError) {
          throw error;
        }
      }
    }

    const items = [...byId.values()];

    logger.info("Monolith TSUM catalog parsed", {
      url,
      gender,
      discoveredPages,
      pageLimit,
      items: items.length,
    });

    return items;
  } finally {
    await browser.close();
  }
}

async function readTsumCatalogPageWithRetries(
  page: Page,
  url: string,
  config: MonolithConfig,
  pageNumber: number,
): Promise<TsumCatalogPage> {
  const attempts = Math.max(1, config.catalog.tsumPageRetryAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await readTsumCatalogPage(page, url, config);

      if (result.products.length > 0) {
        return result;
      }

      lastError = new Error(`TSUM page ${pageNumber} returned no products`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      const delayMs = config.catalog.tsumRetryDelayMs * attempt;

      logger.warn("Monolith TSUM catalog page retry scheduled", {
        url,
        page: pageNumber,
        attempt,
        attempts,
        delayMs,
        error: errorMessage(lastError),
      });

      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`TSUM page ${pageNumber} parse failed`);
}

async function readTsumCatalogPage(
  page: Page,
  url: string,
  config: MonolithConfig,
): Promise<TsumCatalogPage> {
  const response = await page.goto(url, {
    waitUntil: config.catalog.browserWaitUntil,
    timeout: config.catalog.browserTimeoutMs,
  });
  const html = await page.content();
  const title = await page.title();
  const state = readInitialState(html);

  if (!state) {
    return {
      url,
      title,
      status: response?.status(),
      products: [],
    };
  }

  const data = readCatalogData(state, url);
  const products = readCatalogProducts(data);

  return {
    url,
    title,
    status: response?.status(),
    products,
    pageCount: numberValue(data?.pageCount),
    currentPage: numberValue(data?.currentPage),
    perPage: numberValue(data?.perPage),
    total: numberValue(data?.total),
  };
}

function readInitialState(html: string): JsonObject | undefined {
  const match = html.match(/<script[^>]*id=["']__INITIAL_STATE__["'][^>]*>([\s\S]*?)<\/script>/i);
  const rawState = match?.[1]?.trim();

  if (!rawState) {
    return undefined;
  }

  try {
    return asObject(JSON.parse(decodeHtmlEntities(rawState)));
  } catch (error) {
    logger.warn("Monolith TSUM initial state JSON parse failed", { error });
    return undefined;
  }
}

function readCatalogData(state: JsonObject, pageUrl: string): JsonObject | undefined {
  const catalogs = asObject(state.catalogs);
  const catalogList = asObject(catalogs?.list);

  if (!catalogList) {
    return undefined;
  }

  const preferredKey = catalogKeyFromUrl(pageUrl);
  const keys = preferredKey
    ? [preferredKey, ...Object.keys(catalogList).filter((key) => key !== preferredKey)]
    : Object.keys(catalogList);
  let fallback: JsonObject | undefined;

  for (const key of keys) {
    const catalog = asObject(catalogList[key]);
    const data = asObject(catalog?.data);

    if (!data) {
      continue;
    }

    fallback ??= data;

    if (readCatalogProducts(data).length > 0) {
      return data;
    }
  }

  return fallback;
}

function readCatalogProducts(data: JsonObject | undefined): JsonObject[] {
  return asArray(data?.list)
    ?.map((item) => asObject(item))
    .filter((item): item is JsonObject => Boolean(item)) ?? [];
}

function normalizeTsumProduct(
  product: JsonObject,
  pageUrl: string,
  gender: GarmentGender,
): GarmentCatalogItem[] {
  const slug = stringValue(product.slug);
  const externalId = scalarString(product.ext_id) ?? scalarString(product.id);
  const title = stringValue(product.title);
  const categorySlug = stringValue(product.category_slug);
  const photos = readObjectArray(product.photos);
  const rawImageUrl = chooseTsumImageUrl(photos);
  const imageUrl = rawImageUrl ? absolutizeTsumUrl(rawImageUrl, pageUrl) : undefined;

  if (!slug || !externalId || !title || !imageUrl) {
    logger.debug("Monolith TSUM product skipped because required fields are missing", {
      slug,
      externalId,
      title,
      hasImage: Boolean(imageUrl),
    });
    return [];
  }

  const brandName = stringValue(product.brand_name);
  const color = readTsumColor(product);
  const category = inferCategory(title, categorySlug);
  const season = stringValue(product.season);
  const categoryType = stringValue(product.categoryType);
  const productUrl = new URL("/product/" + slug + "/", pageUrl).toString();
  const now = new Date().toISOString();
  const genderLabel = labelForGender(gender);

  return [
    {
      id: `tsum:${externalId}`,
      provider: "tsum",
      externalId,
      productUrl,
      title,
      category,
      gender,
      genderLabel,
      description: stringValue(product.image_alt),
      brand: brandName,
      store: "ЦУМ",
      price: readTsumPrice(product),
      currency: "RUB",
      imageUrl,
      imageFilename: filenameFromUrl(imageUrl) ?? `${externalId}.jpg`,
      tags: uniqueStrings([
        "цум",
        "tsum",
        gender,
        genderLabel.toLowerCase(),
        brandName,
        title,
        category,
        categorySlug,
        color,
        season,
        categoryType,
      ].filter((item): item is string => Boolean(item))),
      colorTags: color ? [color] : [],
      styleTags: readTagTitles(product.tags),
      materialTags: [],
      metadata: {
        sourcePage: pageUrl,
        slug,
        tsumId: scalarString(product.id),
        extId: externalId,
        brandId: scalarString(product.brand_id),
        categoryId: scalarString(product.category_id),
        categorySlug,
        colorCode: stringValue(product.color_code),
        modelId: scalarString(product.model_id),
        inStock: booleanValue(product.inStock),
        season,
        categoryType,
        photoCount: photos.length,
      },
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export async function downloadCatalogImage(
  item: GarmentCatalogItem,
  config: MonolithConfig,
): Promise<{ image: Buffer; contentType: string }> {
  const response = await fetchWithTimeout(
    item.imageUrl,
    {
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: item.productUrl,
        "User-Agent": config.catalog.userAgent,
      },
    },
    config.httpTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Catalog image download failed with ${response.status}`);
  }

  return {
    image: await readResponseBuffer(response, config.maxDownloadBytes),
    contentType: response.headers.get("content-type") ?? contentTypeFromFilename(item.imageFilename),
  };
}

function chooseTsumImageUrl(photos: JsonObject[]): string | undefined {
  for (const photo of photos) {
    for (const field of TSUM_PRODUCT_IMAGE_FIELDS) {
      const value = stringValue(photo[field]);

      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function inferCategory(title: string, categorySlug: string | undefined): string {
  return (
    inferCategoryFromText(categorySlug ?? "") ??
    inferCategoryFromText(title) ??
    title
  );
}

function inferCategoryFromText(value: string): string | undefined {
  const source = value.toLowerCase();

  if (!source) {
    return undefined;
  }

  const rules: Array<[RegExp, string]> = [
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

  for (const [pattern, category] of rules) {
    if (pattern.test(source)) {
      return category;
    }
  }

  return undefined;
}
function readTsumColor(product: JsonObject): string | undefined {
  const colorConcrete = asObject(product.colorConcrete);

  return stringValue(colorConcrete?.title) ?? stringValue(product.color_code);
}

function readTsumPrice(product: JsonObject): number | undefined {
  const prices = readObjectArray(product.skuList)
    .flatMap((sku) => [
      numberValue(sku.price_discount),
      numberValue(sku.price_original),
    ])
    .filter((value): value is number => Number.isFinite(value));

  return prices.length ? Math.min(...prices) : numberValue(product.price);
}

function readTagTitles(value: unknown): string[] {
  return uniqueStrings(readObjectArray(value).flatMap((item) => [
    stringValue(item.title),
    stringValue(item.name),
    stringValue(item.slug),
  ]).filter((item): item is string => Boolean(item)));
}

function readObjectArray(value: unknown): JsonObject[] {
  return (asArray(value) ?? [])
    .map((item) => asObject(item))
    .filter((item): item is JsonObject => Boolean(item));
}

function asObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonObject;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? emptyToUndefined(value) : undefined;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return emptyToUndefined(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function catalogKeyFromUrl(value: string): string | undefined {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).at(-1);
  } catch {
    return undefined;
  }
}

function pageUrlFor(value: string, pageNumber: number): string {
  const next = new URL(value);

  if (pageNumber <= 1) {
    next.searchParams.delete("page");
  } else {
    next.searchParams.set("page", String(pageNumber));
  }

  return next.toString();
}

function filenameFromUrl(value: string): string | undefined {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).at(-1) || undefined;
  } catch {
    return undefined;
  }
}

function absolutizeTsumUrl(value: string, pageUrl: string): string {
  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  return new URL(value, pageUrl).toString();
}

function contentTypeFromFilename(filename: string): string {
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

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#x22;/gi, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}