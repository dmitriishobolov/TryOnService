import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCatalogPage, type CatalogPageSnapshot } from "../../../browser/pageReader.js";
import { createLogger } from "../../../../shared/logger.js";
import type { CatalogGarmentDraft, CatalogProviderContext } from "../../types.js";

const logger = createLogger("catalog-ingestor");
const DEFAULT_TSUM_START_URL = "https://www.tsum.ru/catalog/odezhda-18413/";

// Для ручной проверки TSUM parser-а без coordinator/storage меняйте URL тут.
const DIRECT_RUN_URL = DEFAULT_TSUM_START_URL;
const DIRECT_RUN_BATCH_SIZE = 10;

interface TsumProductCandidate {
  externalId?: string;
  productUrl: string;
  title: string;
  category?: string;
  description?: string;
  tags?: string[];
  colorTags?: string[];
  styleTags?: string[];
  materialTags?: string[];
  price?: string | number;
  currency?: string;
  store?: string;
  imageUrl: string;
  imageFilename?: string;
  metadata?: Record<string, unknown>;
}

export async function collectTsumCatalog(
  context: CatalogProviderContext,
): Promise<CatalogGarmentDraft[]> {
  const page = await readTsumCatalogPage(context, context.tsumStartUrl ?? DEFAULT_TSUM_START_URL);
  const candidates = parseTsumCatalogPage(page, context);
  const drafts = normalizeTsumCandidates(candidates, context.batchSize);

  logger.info("TSUM parser collected drafts", {
    sourceUrl: page.url,
    candidates: candidates.length,
    drafts: drafts.length,
  });

  return drafts;
}

export async function readTsumCatalogPage(
  context: CatalogProviderContext,
  url: string,
): Promise<CatalogPageSnapshot> {
  const page = await readCatalogPage({
    url,
    userAgent: context.userAgent,
    headless: context.browserHeadless,
    timeoutMs: context.browserTimeoutMs,
    waitUntil: context.browserWaitUntil,
    textMaxChars: context.browserTextMaxChars,
    linksMaxCount: context.browserLinksMaxCount,
  });

  logger.info("TSUM parser page read", {
    requestedUrl: page.requestedUrl,
    finalUrl: page.url,
    status: page.status,
    ok: page.ok,
    title: page.title,
    htmlLength: page.html.length,
    textLength: page.text.length,
    links: page.links.length,
  });

  logger.debug("TSUM parser page text preview", {
    title: page.title,
    textPreview: page.text.slice(0, 1_000),
    firstLinks: page.links.slice(0, 10),
  });

  return page;
}

export function parseTsumCatalogPage(
  page: CatalogPageSnapshot,
  context: CatalogProviderContext,
): TsumProductCandidate[] {
  void context;

  const state = readInitialState(page.html);

  if (!state) {
    logger.warn("TSUM initial state was not found", { sourceUrl: page.url });
    return [];
  }

  const products = readCatalogProducts(state, page.url);

  if (products.length === 0) {
    logger.warn("TSUM catalog products were not found in initial state", {
      sourceUrl: page.url,
    });
    return [];
  }

  return products.flatMap((product) => normalizeTsumProduct(product, page.url));
}

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

function readInitialState(html: string): JsonObject | undefined {
  const match = html.match(/<script[^>]*id=["']__INITIAL_STATE__["'][^>]*>([\s\S]*?)<\/script>/i);
  const rawState = match?.[1]?.trim();

  if (!rawState) {
    return undefined;
  }

  try {
    return asObject(JSON.parse(decodeHtmlEntities(rawState)));
  } catch (error) {
    logger.warn("TSUM initial state JSON parse failed", { error });
    return undefined;
  }
}

function readCatalogProducts(state: JsonObject, pageUrl: string): JsonObject[] {
  const catalogs = asObject(state.catalogs);
  const catalogList = asObject(catalogs?.list);

  if (!catalogList) {
    return [];
  }

  const preferredKey = catalogKeyFromUrl(pageUrl);
  const keys = preferredKey
    ? [preferredKey, ...Object.keys(catalogList).filter((key) => key !== preferredKey)]
    : Object.keys(catalogList);

  for (const key of keys) {
    const catalog = asObject(catalogList[key]);
    const data = asObject(catalog?.data);
    const list = asArray(data?.list);
    const products = list
      ?.map((item) => asObject(item))
      .filter((item): item is JsonObject => Boolean(item)) ?? [];

    if (products.length > 0) {
      return products;
    }
  }

  return [];
}

function normalizeTsumProduct(
  product: JsonObject,
  pageUrl: string,
): TsumProductCandidate[] {
  const slug = stringValue(product.slug);
  const externalId = scalarString(product.ext_id) ?? scalarString(product.id);
  const title = stringValue(product.title);
  const categorySlug = stringValue(product.category_slug);
  const category = title ?? categoryFromSlug(categorySlug) ?? "одежда";
  const photos = readObjectArray(product.photos);
  const imageUrl = chooseTsumImageUrl(photos);

  if (!slug || !externalId || !title || !imageUrl) {
    logger.debug("TSUM product skipped because required fields are missing", {
      slug,
      externalId,
      title,
      hasImage: Boolean(imageUrl),
    });
    return [];
  }

  const brandName = stringValue(product.brand_name);
  const color = readTsumColor(product);
  const price = readTsumPrice(product);
  const season = stringValue(product.season);
  const categoryType = stringValue(product.categoryType);
  const productUrl = absoluteUrl("/product/" + slug + "/", pageUrl);

  return [
    {
      externalId,
      productUrl,
      title,
      category,
      description: stringValue(product.image_alt),
      tags: uniqueStrings([
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
      price,
      currency: "RUB",
      store: "ЦУМ",
      imageUrl,
      imageFilename: filenameFromUrl(imageUrl) ?? externalId + ".jpg",
      metadata: {
        sourcePage: pageUrl,
        tsumId: scalarString(product.id),
        extId: externalId,
        slug,
        brandId: scalarString(product.brand_id),
        brandName,
        categoryId: scalarString(product.category_id),
        categorySlug,
        colorCode: stringValue(product.color_code),
        modelId: scalarString(product.model_id),
        inStock: booleanValue(product.inStock),
        isPreorder: booleanValue(product.isPreorder),
        isSpecialOffer: booleanValue(product.isSpecialOffer),
        season,
        categoryType,
        photoCount: photos.length,
      },
    },
  ];
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

function readTsumColor(product: JsonObject): string | undefined {
  const colorConcrete = asObject(product.colorConcrete);

  return stringValue(colorConcrete?.title) ?? stringValue(product.color_code);
}

function readTsumPrice(product: JsonObject): string | undefined {
  const prices = readObjectArray(product.skuList).flatMap((sku) => [
    numberValue(sku.price_discount),
    numberValue(sku.price_original),
  ]).filter((value): value is number => Number.isFinite(value));

  if (prices.length === 0) {
    return scalarString(product.price);
  }

  return String(Math.min(...prices));
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
    const normalized = value.replace(/\s+/g, "").replace(",", ".");
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function categoryFromSlug(value: string | undefined): string | undefined {
  return value
    ?.replace(/-[0-9]+/g, "")
    .replace(/-/g, " ")
    .trim() || undefined;
}

function catalogKeyFromUrl(value: string): string | undefined {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).at(-1);
  } catch {
    return undefined;
  }
}

function absoluteUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString();
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

function normalizeTsumCandidates(
  candidates: TsumProductCandidate[],
  batchSize: number,
): CatalogGarmentDraft[] {
  return candidates.slice(0, batchSize).flatMap((candidate) => {
    const externalId = candidate.externalId?.trim() || externalIdFromUrl(candidate.productUrl);
    const category = candidate.category?.trim() || "одежда";
    const title = candidate.title.trim();
    const imageUrl = candidate.imageUrl.trim();
    const productUrl = candidate.productUrl.trim();

    if (!externalId || !title || !productUrl || !imageUrl) {
      logger.warn("TSUM product candidate skipped because required fields are missing", {
        productUrl: candidate.productUrl,
        title: candidate.title,
        imageUrl: candidate.imageUrl,
      });
      return [];
    }

    return [
      {
        provider: "tsum" as const,
        externalId,
        productUrl,
        title,
        category,
        description: emptyToUndefined(candidate.description),
        tags: uniqueStrings(["цум", "tsum", ...(candidate.tags ?? [])]),
        colorTags: uniqueStrings(candidate.colorTags ?? []),
        styleTags: uniqueStrings(candidate.styleTags ?? []),
        materialTags: uniqueStrings(candidate.materialTags ?? []),
        price: optionalScalarString(candidate.price),
        currency: emptyToUndefined(candidate.currency) ?? "RUB",
        store: emptyToUndefined(candidate.store) ?? "ЦУМ",
        image: {
          url: imageUrl,
          filename: candidate.imageFilename ?? filenameFromUrl(imageUrl),
        },
        metadata: {
          ...candidate.metadata,
          marketplace: "tsum",
        },
      },
    ];
  });
}

function externalIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const candidate = parts.at(-1)?.replace(/\.[a-z0-9]+$/i, "");

    if (candidate) {
      return candidate;
    }
  } catch {
    // Fall back to a stable hash below.
  }

  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function filenameFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const filename = url.pathname.split("/").filter(Boolean).at(-1);

    return filename || undefined;
  } catch {
    return basename(value) || undefined;
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function optionalScalarString(value: string | number | undefined): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }

  return emptyToUndefined(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

if (isDirectRun()) {
  await runDirectParser();
}

async function runDirectParser(): Promise<void> {
  const items = await collectTsumCatalog({
    batchSize: DIRECT_RUN_BATCH_SIZE,
    userAgent: "TryOnServiceCatalogIngestor/0.1",
    tsumStartUrl: DIRECT_RUN_URL,
    browserHeadless: true,
    browserTimeoutMs: 30_000,
    browserWaitUntil: "domcontentloaded",
    browserTextMaxChars: 20_000,
    browserLinksMaxCount: 100,
  });

  console.log(JSON.stringify(items, null, 2));
}

function isDirectRun(): boolean {
  const scriptPath = process.argv[1];

  if (!scriptPath) {
    return false;
  }

  return resolve(scriptPath).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}
