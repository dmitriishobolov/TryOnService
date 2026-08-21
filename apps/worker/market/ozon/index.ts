import type {
  MarketProductPrice,
  MarketProductRef,
  MarketSearchSelection,
} from "../../../shared/contracts/index.js";
import { createLogger } from "../../../shared/logger.js";
import type { WorkerConfig } from "../../config/index.js";
import type { MarketplaceAdapter, MarketplaceSearchResult } from "../types.js";
import {
  fetchWithTimeout,
  formatProductUrl,
  limitProducts,
  marketplaceResponseError,
  MarketplaceError,
  matchesSearchQuery,
  numberFromUnknown,
} from "../utils.js";

const provider = "ozon";
const logger = createLogger("worker");
const publicSearchCache = new Map<string, OzonPublicCacheEntry>();
const publicSearchInflight = new Map<string, Promise<MarketProductRef[]>>();
let publicSearchCooldownUntilMs = 0;

interface OzonPublicCacheEntry {
  products: MarketProductRef[];
  expiresAtMs: number;
  staleUntilMs: number;
}

interface OzonProductPageData {
  title?: string;
  imageUrl?: string;
  images?: string[];
  price?: MarketProductPrice;
  brand?: string;
  category?: string;
}

export const ozonMarketplaceAdapter: MarketplaceAdapter = {
  provider,
  displayName: "Ozon",
  isConfigured: (config) =>
    Boolean(
      config.market.ozon.publicSearchBaseUrl &&
        config.market.ozon.publicProductBaseUrl,
    ),
  search: async ({
    query,
    selection,
    config,
    signal,
  }): Promise<MarketplaceSearchResult> => {
    const limit = Math.min(selection.limit ?? config.market.searchLimit, 100);
    const cacheKey = buildOzonPublicCacheKey(query, selection, config);
    const products = (
      await getCachedOrFetchOzonPublicProducts(cacheKey, config, () =>
        fetchOzonPublicProducts(query, selection, config, signal),
      )
    )
      .filter((product) => matchesSearchQuery(product, query))
      .filter((product) =>
        matchesPrice(product, selection.minPrice, selection.maxPrice),
      );

    return {
      provider,
      products: limitProducts(products, limit),
    };
  },
};

async function fetchOzonPublicProducts(
  query: string,
  selection: MarketSearchSelection,
  config: WorkerConfig,
  signal?: AbortSignal,
): Promise<MarketProductRef[]> {
  const marketConfig = config.market.ozon;
  const productUrls = new Set<string>();

  for (let page = 1; page <= marketConfig.publicSearchPages; page += 1) {
    const searchHtml = await fetchOzonSearchPage(query, page, config, signal);
    const links = extractOzonProductLinks(
      searchHtml,
      marketConfig.publicProductBaseUrl,
    );

    for (const link of links) {
      productUrls.add(link);

      if (productUrls.size >= marketConfig.maxScanProducts) {
        break;
      }
    }

    if (productUrls.size >= marketConfig.maxScanProducts || links.length === 0) {
      break;
    }
  }

  const products: MarketProductRef[] = [];

  for (const productUrl of productUrls) {
    const product = await fetchOzonProduct(productUrl, config, signal).catch(
      (error: unknown) => {
        logger.warn("Ozon public product page parse failed", {
          productUrl,
          error,
        });
        return undefined;
      },
    );

    if (product) {
      products.push(product);
    }

    if (products.length >= (selection.limit ?? config.market.searchLimit)) {
      break;
    }
  }

  return products;
}

async function fetchOzonSearchPage(
  query: string,
  page: number,
  config: WorkerConfig,
  signal?: AbortSignal,
): Promise<string> {
  const marketConfig = config.market.ozon;
  const url = new URL(marketConfig.publicSearchBaseUrl);

  url.searchParams.set("text", query);
  url.searchParams.set("from_global", "true");

  if (page > 1) {
    url.searchParams.set("page", String(page));
  }

  return fetchOzonHtml(url.toString(), config, signal);
}

async function fetchOzonProduct(
  productUrl: string,
  config: WorkerConfig,
  signal?: AbortSignal,
): Promise<MarketProductRef | undefined> {
  const html = await fetchOzonHtml(productUrl, config, signal);
  const data = parseOzonProductPage(html);
  const productId = extractOzonProductId(productUrl);
  const title = data.title?.trim();

  if (!productId || !title) {
    return undefined;
  }

  return {
    provider,
    productId,
    title,
    productUrl:
      formatProductUrl(config.market.ozon.productUrlTemplate, {
        productId,
        sku: productId,
      }) ?? productUrl,
    imageUrl: data.imageUrl,
    images: data.images,
    price: data.price,
    brand: data.brand,
    category: data.category,
  };
}

async function fetchOzonHtml(
  url: string,
  config: WorkerConfig,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        Referer: "https://www.ozon.ru/",
        "User-Agent": config.market.ozon.publicUserAgent,
      },
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );

  if (!response.ok) {
    throw await marketplaceResponseError(provider, response);
  }

  return response.text();
}

async function getCachedOrFetchOzonPublicProducts(
  cacheKey: string,
  config: WorkerConfig,
  fetcher: () => Promise<MarketProductRef[]>,
): Promise<MarketProductRef[]> {
  const now = Date.now();
  const freshEntry = getOzonPublicCacheEntry(cacheKey, now, "fresh");

  if (freshEntry) {
    logger.debug("Ozon public search cache hit", {
      cacheKey,
      products: freshEntry.products.length,
    });
    return freshEntry.products;
  }

  const staleEntry = getOzonPublicCacheEntry(cacheKey, now, "stale");

  if (now < publicSearchCooldownUntilMs) {
    if (staleEntry) {
      logger.warn("Ozon public search cooldown used stale cache", {
        cacheKey,
        products: staleEntry.products.length,
        cooldownMs: publicSearchCooldownUntilMs - now,
      });
      return staleEntry.products;
    }

    throw new MarketplaceError(
      "ozon_public_rate_limited",
      "Ozon public search is cooling down after rate limit or redirect loop",
      true,
    );
  }

  const inflight = publicSearchInflight.get(cacheKey);

  if (inflight) {
    logger.debug("Ozon public search joined in-flight request", {
      cacheKey,
    });
    return inflight;
  }

  const request = fetcher()
    .then((products) => {
      putOzonPublicCacheEntry(cacheKey, products, config);
      logger.debug("Ozon public search cache stored", {
        cacheKey,
        products: products.length,
      });
      return products;
    })
    .catch((error: unknown) => {
      if (shouldCooldownOzonPublicSearch(error)) {
        publicSearchCooldownUntilMs =
          Date.now() + config.market.ozon.publicErrorCooldownMs;
      }

      if (staleEntry && !isAbortError(error)) {
        logger.warn("Ozon public search failed, using stale cache", {
          cacheKey,
          products: staleEntry.products.length,
          error,
        });
        return staleEntry.products;
      }

      throw error;
    })
    .finally(() => {
      publicSearchInflight.delete(cacheKey);
    });

  publicSearchInflight.set(cacheKey, request);

  return request;
}

function buildOzonPublicCacheKey(
  query: string,
  selection: MarketSearchSelection,
  config: WorkerConfig,
): string {
  const marketConfig = config.market.ozon;

  return [
    "v1",
    normalizeCacheValue(marketConfig.publicSearchBaseUrl),
    normalizeCacheValue(query),
    normalizeCacheValue(selection.currency ?? "rub"),
    normalizeCacheValue(selection.locale ?? "ru"),
    normalizeCacheValue(selection.country ?? "ru"),
    normalizeCacheValue(selection.sort ?? ""),
    String(marketConfig.publicSearchPages),
  ].join("|");
}

function getOzonPublicCacheEntry(
  cacheKey: string,
  now: number,
  mode: "fresh" | "stale",
): OzonPublicCacheEntry | undefined {
  const entry = publicSearchCache.get(cacheKey);

  if (!entry) {
    return undefined;
  }

  if (now > entry.staleUntilMs) {
    publicSearchCache.delete(cacheKey);
    return undefined;
  }

  if (mode === "fresh" && now > entry.expiresAtMs) {
    return undefined;
  }

  publicSearchCache.delete(cacheKey);
  publicSearchCache.set(cacheKey, entry);

  return entry;
}

function putOzonPublicCacheEntry(
  cacheKey: string,
  products: MarketProductRef[],
  config: WorkerConfig,
): void {
  const maxEntries = config.market.ozon.publicCacheMaxEntries;

  if (maxEntries <= 0) {
    return;
  }

  const now = Date.now();
  const expiresAtMs = now + config.market.ozon.publicCacheTtlMs;
  const staleUntilMs = expiresAtMs + config.market.ozon.publicCacheStaleTtlMs;

  publicSearchCache.delete(cacheKey);
  publicSearchCache.set(cacheKey, {
    products,
    expiresAtMs,
    staleUntilMs,
  });
  pruneOzonPublicCache(maxEntries);
}

function pruneOzonPublicCache(maxEntries: number): void {
  const now = Date.now();

  for (const [cacheKey, entry] of publicSearchCache) {
    if (now > entry.staleUntilMs) {
      publicSearchCache.delete(cacheKey);
    }
  }

  while (publicSearchCache.size > maxEntries) {
    const oldestKey = publicSearchCache.keys().next().value;

    if (!oldestKey) {
      return;
    }

    publicSearchCache.delete(oldestKey);
  }
}

function extractOzonProductLinks(html: string, productBaseUrl: string): string[] {
  const normalizedHtml = html.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  const links = new Set<string>();
  const patterns = [
    /href=["']([^"']*\/product\/[^"']+)["']/gi,
    /(?:https?:\/\/www\.ozon\.ru)?\/product\/[^\s"'<>\\]+/gi,
  ];

  for (const pattern of patterns) {
    for (const match of normalizedHtml.matchAll(pattern)) {
      const rawHref = match[1] ?? match[0];
      const cleanUrl = normalizeOzonProductUrl(rawHref, productBaseUrl);

      if (cleanUrl) {
        links.add(cleanUrl);
      }
    }
  }

  return [...links];
}

function normalizeOzonProductUrl(
  rawHref: string,
  productBaseUrl: string,
): string | undefined {
  const decodedHref = decodeHtmlEntities(rawHref).replaceAll("\\", "");

  try {
    const url = new URL(decodedHref, productBaseUrl);

    if (!url.hostname.endsWith("ozon.ru") || !url.pathname.includes("/product/")) {
      return undefined;
    }

    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return undefined;
  }
}

function parseOzonProductPage(html: string): OzonProductPageData {
  const structured = parseOzonStructuredProductData(html);
  const metaTitle = readMetaContent(html, ["og:title", "twitter:title"]);
  const h1Title = readTagText(html, "h1");
  const metaImage = readMetaContent(html, ["og:image", "twitter:image"]);
  const metaPrice = readMetaContent(html, [
    "product:price:amount",
    "price",
    "og:price:amount",
  ]);
  const images = uniqueStrings(
    [
      ...(structured.images ?? []),
      structured.imageUrl,
      metaImage,
      ...extractOzonImageUrls(html),
    ].filter(isNonEmptyString),
  );
  const parsedMetaPrice = numberFromUnknown(metaPrice);

  return {
    title: structured.title ?? metaTitle ?? h1Title,
    imageUrl: images[0],
    images: images.length ? images : undefined,
    price:
      structured.price ??
      (parsedMetaPrice
        ? {
            amount: parsedMetaPrice,
            currency: "RUB",
          }
        : undefined),
    brand: structured.brand,
    category: structured.category,
  };
}

function parseOzonStructuredProductData(html: string): OzonProductPageData {
  for (const jsonText of extractJsonLdBlocks(html)) {
    const parsed = parseJson(jsonText);
    const product = findStructuredProduct(parsed);

    if (product) {
      return normalizeStructuredProduct(product);
    }
  }

  return {};
}

function normalizeStructuredProduct(
  product: Record<string, unknown>,
): OzonProductPageData {
  const imageValue = product.image;
  const images = Array.isArray(imageValue)
    ? imageValue.filter(isNonEmptyString)
    : isNonEmptyString(imageValue)
      ? [imageValue]
      : [];
  const offer = Array.isArray(product.offers)
    ? product.offers.find(isRecord)
    : isRecord(product.offers)
      ? product.offers
      : undefined;
  const price = normalizeOzonPrice(
    offer?.price ?? findNestedValue(product, ["price", "lowPrice", "highPrice"]),
    isNonEmptyString(offer?.priceCurrency) ? offer.priceCurrency : "RUB",
  );
  const brand = isRecord(product.brand)
    ? readStringValue(product.brand.name)
    : readStringValue(product.brand);

  return {
    title: readStringValue(product.name),
    imageUrl: images[0],
    images: images.length ? images : undefined,
    price,
    brand,
    category: readStringValue(product.category),
  };
}

function normalizeOzonPrice(
  value: unknown,
  currency?: string,
): MarketProductPrice | undefined {
  const amount = numberFromUnknown(value);

  if (amount === undefined || amount <= 0) {
    return undefined;
  }

  return {
    amount,
    currency,
  };
}

function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const pattern =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    if (match[1]) {
      blocks.push(decodeHtmlEntities(match[1].trim()));
    }
  }

  return blocks;
}

function findStructuredProduct(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStructuredProduct(item);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];

  if (types.some((item) => item === "Product")) {
    return value;
  }

  for (const current of Object.values(value)) {
    const found = findStructuredProduct(current);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function readMetaContent(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const escapedName = escapeRegExp(name);
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapedName}["'][^>]*>`,
        "i",
      ),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);

      if (match?.[1]) {
        return stripTags(decodeHtmlEntities(match[1])).trim();
      }
    }
  }

  return undefined;
}

function readTagText(html: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = html.match(pattern);

  return match?.[1] ? stripTags(decodeHtmlEntities(match[1])).trim() : undefined;
}

function extractOzonImageUrls(html: string): string[] {
  const urls = new Set<string>();
  const normalizedHtml = html.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  const pattern = /https?:\/\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi;

  for (const match of normalizedHtml.matchAll(pattern)) {
    const url = decodeHtmlEntities(match[0]);

    if (url.includes("ozon") || url.includes("cdn")) {
      urls.add(url);
    }
  }

  return [...urls];
}

function extractOzonProductId(productUrl: string): string | undefined {
  const match = productUrl.match(/\/product\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/i);

  return match?.[1];
}

function findNestedValue(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedValue(item, keys);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    if (value[key] !== undefined) {
      return value[key];
    }
  }

  for (const current of Object.values(value)) {
    const found = findNestedValue(current, keys);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function shouldCooldownOzonPublicSearch(error: unknown): boolean {
  if (error instanceof MarketplaceError) {
    return error.retryable || error.code === "ozon_api_403";
  }

  return (
    error instanceof Error &&
    /redirect|fetch failed|terminated|network/i.test(error.message)
  );
}

function matchesPrice(
  product: MarketProductRef,
  minPrice: number | undefined,
  maxPrice: number | undefined,
): boolean {
  if (!product.price) {
    return true;
  }

  return (
    (minPrice === undefined || product.price.amount >= minPrice) &&
    (maxPrice === undefined || product.price.amount <= maxPrice)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readStringValue(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(Number(code)),
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCacheValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
