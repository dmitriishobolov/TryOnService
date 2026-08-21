import type {
  MarketProductPrice,
  MarketProductRef,
  MarketProvider,
  MarketSearchSelection,
} from "../../shared/contracts/index.js";
import { sleep } from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
import type {
  PublicHtmlCatalogMarketConfig,
  WorkerConfig,
} from "../config/index.js";
import type {
  MarketplaceAdapter,
  MarketplaceSearchInput,
  MarketplaceSearchResult,
} from "./types.js";
import {
  fetchWithTimeout,
  formatProductUrl,
  limitProducts,
  marketplaceResponseError,
  MarketplaceError,
  matchesSearchQuery,
  numberFromUnknown,
  summarizeMarketplaceError,
} from "./utils.js";

const logger = createLogger("worker");

export interface PublicHtmlCatalogSearchUrlParams {
  query: string;
  page: number;
  selection: MarketSearchSelection;
  marketConfig: PublicHtmlCatalogMarketConfig;
}

export interface PublicHtmlCatalogAdapterOptions {
  provider: MarketProvider;
  displayName: string;
  readConfig(config: WorkerConfig): PublicHtmlCatalogMarketConfig;
  buildSearchUrls?(params: PublicHtmlCatalogSearchUrlParams): string[];
  productLinkPattern?: RegExp;
  productPathSegment?: string;
  extractProductId?(productUrl: string): string | undefined;
  blockedPagePatterns?: RegExp[];
  referer?: string;
}

interface PublicHtmlCatalogCacheEntry {
  products: MarketProductRef[];
  expiresAtMs: number;
  staleUntilMs: number;
}

interface PublicHtmlCatalogCandidate {
  productUrl: string;
  title?: string;
  images?: string[];
  price?: MarketProductPrice;
  brand?: string;
  category?: string;
}

interface PublicHtmlCatalogState {
  cache: Map<string, PublicHtmlCatalogCacheEntry>;
  inflight: Map<string, Promise<MarketProductRef[]>>;
  cooldownUntilMs: number;
  nextRequestAtMs: number;
  throttleQueue: Promise<void>;
}

interface StructuredProductData {
  title?: string;
  images?: string[];
  price?: MarketProductPrice;
  brand?: string;
  category?: string;
}

export function createPublicHtmlCatalogAdapter(
  options: PublicHtmlCatalogAdapterOptions,
): MarketplaceAdapter {
  const state: PublicHtmlCatalogState = {
    cache: new Map(),
    inflight: new Map(),
    cooldownUntilMs: 0,
    nextRequestAtMs: 0,
    throttleQueue: Promise.resolve(),
  };

  return {
    provider: options.provider,
    displayName: options.displayName,
    isConfigured: (config) => {
      const marketConfig = options.readConfig(config);

      return Boolean(
        marketConfig.publicSearchBaseUrl &&
          marketConfig.publicProductBaseUrl &&
          marketConfig.productUrlTemplate,
      );
    },
    search: (input) => searchPublicHtmlCatalog(input, options, state),
  };
}

async function searchPublicHtmlCatalog(
  input: MarketplaceSearchInput,
  options: PublicHtmlCatalogAdapterOptions,
  state: PublicHtmlCatalogState,
): Promise<MarketplaceSearchResult> {
  const marketConfig = options.readConfig(input.config);
  const limit = Math.min(input.selection.limit ?? input.config.market.searchLimit, 100);
  const cacheKey = buildPublicHtmlCatalogCacheKey(
    input.query,
    input.selection,
    marketConfig,
  );
  const products = (
    await getCachedOrFetchPublicHtmlCatalogProducts(
      cacheKey,
      input.config,
      marketConfig,
      options,
      state,
      () => fetchPublicHtmlCatalogProducts(input, options, marketConfig, limit),
    )
  )
    .filter((product) => matchesSearchQuery(product, input.query))
    .filter((product) =>
      matchesPrice(product, input.selection.minPrice, input.selection.maxPrice),
    );

  return {
    provider: options.provider,
    products: limitProducts(products, limit),
  };
}

async function fetchPublicHtmlCatalogProducts(
  input: MarketplaceSearchInput,
  options: PublicHtmlCatalogAdapterOptions,
  marketConfig: PublicHtmlCatalogMarketConfig,
  limit: number,
): Promise<MarketProductRef[]> {
  const candidates = new Map<string, PublicHtmlCatalogCandidate>();

  for (let page = 1; page <= marketConfig.publicSearchPages; page += 1) {
    const searchUrls = buildPublicHtmlSearchUrls(
      input.query,
      input.selection,
      page,
      marketConfig,
      options,
    );
    let fetchedSearchPages = 0;
    let pageCandidateCount = 0;
    let firstSearchError: unknown;

    for (const searchUrl of searchUrls) {
      const html = await fetchPublicHtml(
        searchUrl,
        input.config,
        marketConfig,
        options,
        input.signal,
      ).catch((error: unknown) => {
        firstSearchError ??= error;
        logger.debug("Public HTML catalog search page parse failed", {
          provider: options.provider,
          searchUrl,
          error: summarizeMarketplaceError(error),
        });

        return undefined;
      });

      if (!html) {
        continue;
      }

      fetchedSearchPages += 1;

      const pageCandidates = extractPublicHtmlCatalogCandidates(
        html,
        marketConfig,
        options,
      );

      pageCandidateCount += pageCandidates.length;

      for (const candidate of pageCandidates) {
        candidates.set(candidate.productUrl, mergeCandidates(
          candidates.get(candidate.productUrl),
          candidate,
        ));

        if (candidates.size >= marketConfig.maxScanProducts) {
          break;
        }
      }

      if (candidates.size >= marketConfig.maxScanProducts) {
        break;
      }
    }

    if (fetchedSearchPages === 0 && firstSearchError) {
      throw firstSearchError;
    }

    if (
      candidates.size >= marketConfig.maxScanProducts ||
      pageCandidateCount === 0
    ) {
      break;
    }
  }

  const products: MarketProductRef[] = [];

  for (const candidate of candidates.values()) {
    const product = await fetchPublicHtmlProduct(
      candidate,
      input.config,
      marketConfig,
      options,
      input.signal,
    ).catch((error: unknown) => {
      logger.debug("Public HTML catalog product page parse failed", {
        provider: options.provider,
        productUrl: candidate.productUrl,
        error: summarizeMarketplaceError(error),
      });
      return normalizePublicHtmlCandidate(candidate, marketConfig, options);
    });

    if (product) {
      products.push(product);
    }

    if (products.length >= limit) {
      break;
    }
  }

  return products;
}

function buildPublicHtmlSearchUrls(
  query: string,
  selection: MarketSearchSelection,
  page: number,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
): string[] {
  const customUrls = options.buildSearchUrls?.({
    query,
    page,
    selection,
    marketConfig,
  });

  if (customUrls?.length) {
    return uniqueStrings(customUrls);
  }

  const url = new URL(marketConfig.publicSearchBaseUrl);

  url.searchParams.set(marketConfig.publicSearchParamName, query);

  if (page > 1) {
    url.searchParams.set("page", String(page));
  }

  return [url.toString()];
}

async function fetchPublicHtmlProduct(
  candidate: PublicHtmlCatalogCandidate,
  config: WorkerConfig,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
  signal?: AbortSignal,
): Promise<MarketProductRef | undefined> {
  const html = await fetchPublicHtml(
    candidate.productUrl,
    config,
    marketConfig,
    options,
    signal,
  );
  const structured = parsePublicHtmlProductPage(html);
  const images = uniqueStrings([
    ...(structured.images ?? []),
    ...(candidate.images ?? []),
  ]);
  const title = structured.title ?? candidate.title;

  if (!title) {
    return undefined;
  }

  return normalizePublicHtmlCandidate(
    {
      ...candidate,
      title,
      images,
      price: structured.price ?? candidate.price,
      brand: structured.brand ?? candidate.brand,
      category: structured.category ?? candidate.category,
    },
    marketConfig,
    options,
  );
}

async function fetchPublicHtml(
  url: string,
  config: WorkerConfig,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
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
        Referer: options.referer ?? marketConfig.publicProductBaseUrl,
        "User-Agent": marketConfig.publicUserAgent,
      },
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );

  if (!response.ok) {
    throw await marketplaceResponseError(options.provider, response);
  }

  const html = await response.text();

  if (isBlockedPublicHtmlPage(html, options)) {
    throw new MarketplaceError(
      `${options.provider}_public_blocked`,
      `${options.displayName} returned anti-bot or JavaScript challenge page`,
      true,
    );
  }

  return html;
}

async function getCachedOrFetchPublicHtmlCatalogProducts(
  cacheKey: string,
  config: WorkerConfig,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
  state: PublicHtmlCatalogState,
  fetcher: () => Promise<MarketProductRef[]>,
): Promise<MarketProductRef[]> {
  const now = Date.now();
  const freshEntry = getPublicHtmlCatalogCacheEntry(state, cacheKey, now, "fresh");

  if (freshEntry) {
    logger.debug("Public HTML catalog cache hit", {
      provider: options.provider,
      cacheKey,
      products: freshEntry.products.length,
    });
    return freshEntry.products;
  }

  const staleEntry = getPublicHtmlCatalogCacheEntry(state, cacheKey, now, "stale");

  if (now < state.cooldownUntilMs) {
    if (staleEntry) {
      logger.warn("Public HTML catalog cooldown used stale cache", {
        provider: options.provider,
        cacheKey,
        products: staleEntry.products.length,
        cooldownMs: state.cooldownUntilMs - now,
      });
      return staleEntry.products;
    }

    throw new MarketplaceError(
      `${options.provider}_public_rate_limited`,
      `${options.displayName} public parser is cooling down`,
      true,
    );
  }

  const inflight = state.inflight.get(cacheKey);

  if (inflight) {
    logger.debug("Public HTML catalog joined in-flight request", {
      provider: options.provider,
      cacheKey,
    });
    return inflight;
  }

  const request = waitForPublicHtmlCatalogSlot(state, marketConfig)
    .then(fetcher)
    .then((products) => {
      putPublicHtmlCatalogCacheEntry(state, cacheKey, products, marketConfig);
      logger.debug("Public HTML catalog cache stored", {
        provider: options.provider,
        cacheKey,
        products: products.length,
      });
      return products;
    })
    .catch((error: unknown) => {
      if (shouldCooldownPublicHtmlCatalog(error)) {
        state.cooldownUntilMs = Date.now() + marketConfig.publicErrorCooldownMs;
      }

      if (staleEntry && !isAbortError(error)) {
        logger.warn("Public HTML catalog failed, using stale cache", {
          provider: options.provider,
          cacheKey,
          products: staleEntry.products.length,
          error,
        });
        return staleEntry.products;
      }

      throw error;
    })
    .finally(() => {
      state.inflight.delete(cacheKey);
    });

  state.inflight.set(cacheKey, request);

  return request;
}

async function waitForPublicHtmlCatalogSlot(
  state: PublicHtmlCatalogState,
  marketConfig: PublicHtmlCatalogMarketConfig,
): Promise<void> {
  let releaseQueue: () => void = () => {};
  const previousQueue = state.throttleQueue;
  state.throttleQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previousQueue;

  try {
    const waitMs = Math.max(0, state.nextRequestAtMs - Date.now());

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    state.nextRequestAtMs = Date.now() + marketConfig.publicRequestIntervalMs;
  } finally {
    releaseQueue();
  }
}

function extractPublicHtmlCatalogCandidates(
  html: string,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
): PublicHtmlCatalogCandidate[] {
  const normalizedHtml = normalizePublicHtml(html);
  const candidates = new Map<string, PublicHtmlCatalogCandidate>();

  for (const candidate of extractStructuredCatalogCandidates(
    normalizedHtml,
    marketConfig,
    options,
  )) {
    candidates.set(candidate.productUrl, mergeCandidates(
      candidates.get(candidate.productUrl),
      candidate,
    ));
  }

  for (const productUrl of extractProductLinks(
    normalizedHtml,
    marketConfig.publicProductBaseUrl,
    options,
  )) {
    const chunk = extractProductChunk(
      normalizedHtml,
      productUrl,
      marketConfig.publicProductBaseUrl,
    );
    const images = uniqueStrings(extractImageUrls(chunk));
    const candidate: PublicHtmlCatalogCandidate = {
      productUrl,
      title: extractCandidateTitle(chunk) ?? titleFromProductUrl(productUrl, options),
      images: images.length ? images : undefined,
    };

    candidates.set(productUrl, mergeCandidates(candidates.get(productUrl), candidate));
  }

  return [...candidates.values()];
}

function extractStructuredCatalogCandidates(
  html: string,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
): PublicHtmlCatalogCandidate[] {
  const candidates: PublicHtmlCatalogCandidate[] = [];

  for (const jsonText of extractJsonLdBlocks(html)) {
    const parsed = parseJson(jsonText);
    collectStructuredCatalogCandidates(
      parsed,
      marketConfig,
      options,
      candidates,
    );
  }

  return candidates;
}

function collectStructuredCatalogCandidates(
  value: unknown,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
  candidates: PublicHtmlCatalogCandidate[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredCatalogCandidates(item, marketConfig, options, candidates);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];

  if (types.some((item) => item === "Product")) {
    const candidate = structuredProductToCandidate(
      value,
      marketConfig,
      options,
    );

    if (candidate) {
      candidates.push(candidate);
    }
  }

  if (types.some((item) => item === "ItemList")) {
    const elements = Array.isArray(value.itemListElement)
      ? value.itemListElement
      : [];

    for (const element of elements) {
      const item = isRecord(element) && isRecord(element.item)
        ? element.item
        : element;
      const candidate = structuredProductToCandidate(
        isRecord(item) ? item : element,
        marketConfig,
        options,
      );

      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  for (const current of Object.values(value)) {
    if (Array.isArray(current) || isRecord(current)) {
      collectStructuredCatalogCandidates(
        current,
        marketConfig,
        options,
        candidates,
      );
    }
  }
}

function structuredProductToCandidate(
  value: unknown,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
): PublicHtmlCatalogCandidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawUrl = readStringValue(value.url);
  const productUrl = rawUrl
    ? normalizeProductUrl(rawUrl, marketConfig.publicProductBaseUrl, options)
    : undefined;

  if (!productUrl) {
    return undefined;
  }

  const offer = Array.isArray(value.offers)
    ? value.offers.find(isRecord)
    : isRecord(value.offers)
      ? value.offers
      : undefined;
  const images = imageValues(value.image);
  const brand = isRecord(value.brand)
    ? readStringValue(value.brand.name)
    : readStringValue(value.brand);

  return {
    productUrl,
    title: readStringValue(value.name),
    images: images.length ? images : undefined,
    price: normalizePrice(
      offer?.price ?? findNestedValue(value, ["price", "lowPrice", "highPrice"]),
      readStringValue(offer?.priceCurrency) ?? "RUB",
    ),
    brand,
    category: readStringValue(value.category),
  };
}

function parsePublicHtmlProductPage(html: string): StructuredProductData {
  const structured = parseStructuredProductPage(html);
  const metaTitle = readMetaContent(html, ["og:title", "twitter:title"]);
  const h1Title = readTagText(html, "h1");
  const metaImages = [
    readMetaContent(html, ["og:image", "twitter:image"]),
    ...extractImageUrls(html),
  ].filter(isNonEmptyString);
  const metaPrice = readMetaContent(html, [
    "product:price:amount",
    "price",
    "og:price:amount",
  ]);
  const images = uniqueStrings([
    ...(structured.images ?? []),
    ...metaImages,
  ]);
  const parsedMetaPrice = numberFromUnknown(metaPrice);

  return {
    title: structured.title ?? metaTitle ?? h1Title,
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

function parseStructuredProductPage(html: string): StructuredProductData {
  for (const jsonText of extractJsonLdBlocks(html)) {
    const parsed = parseJson(jsonText);
    const product = findStructuredProduct(parsed);

    if (product) {
      return structuredProductToData(product);
    }
  }

  return {};
}

function structuredProductToData(
  product: Record<string, unknown>,
): StructuredProductData {
  const offer = Array.isArray(product.offers)
    ? product.offers.find(isRecord)
    : isRecord(product.offers)
      ? product.offers
      : undefined;
  const brand = isRecord(product.brand)
    ? readStringValue(product.brand.name)
    : readStringValue(product.brand);

  return {
    title: readStringValue(product.name),
    images: imageValues(product.image),
    price: normalizePrice(
      offer?.price ?? findNestedValue(product, ["price", "lowPrice", "highPrice"]),
      readStringValue(offer?.priceCurrency) ?? "RUB",
    ),
    brand,
    category: readStringValue(product.category),
  };
}

function normalizePublicHtmlCandidate(
  candidate: PublicHtmlCatalogCandidate,
  marketConfig: PublicHtmlCatalogMarketConfig,
  options: PublicHtmlCatalogAdapterOptions,
): MarketProductRef | undefined {
  const productId =
    options.extractProductId?.(candidate.productUrl) ??
    extractGenericProductId(candidate.productUrl, options);
  const productSlug = extractProductSlug(candidate.productUrl, options);
  const title = candidate.title ?? titleFromProductUrl(candidate.productUrl, options);
  const images = uniqueStrings(candidate.images ?? []);

  if (!productId || !title) {
    return undefined;
  }

  return {
    provider: options.provider,
    productId,
    title,
    productUrl:
      formatProductUrl(marketConfig.productUrlTemplate, {
        productId,
        productSlug,
        slug: productSlug,
        sku: productId,
      }) ?? candidate.productUrl,
    imageUrl: images[0],
    images: images.length ? images : undefined,
    price: candidate.price,
    brand: candidate.brand,
    category: candidate.category,
  };
}

function extractProductLinks(
  html: string,
  productBaseUrl: string,
  options: PublicHtmlCatalogAdapterOptions,
): string[] {
  const links = new Set<string>();
  const escapedBase = escapeRegExp(productBaseUrl.replace(/\/+$/, ""));
  const productLinkPattern = options.productLinkPattern ?? /\/product\/[^\s"'<>\\]+/i;
  const patterns = [
    /href=["']([^"']*\/product\/[^"']+)["']/gi,
    new RegExp(`${escapedBase}\\/product\\/[^\\s"'<>\\\\]+`, "gi"),
    new RegExp(productLinkPattern.source, ensureGlobalFlags(productLinkPattern)),
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const rawHref = match[1] ?? match[0];
      const cleanUrl = normalizeProductUrl(rawHref, productBaseUrl, options);

      if (cleanUrl) {
        links.add(cleanUrl);
      }
    }
  }

  return [...links];
}

function normalizeProductUrl(
  rawHref: string,
  productBaseUrl: string,
  options: PublicHtmlCatalogAdapterOptions,
): string | undefined {
  const decodedHref = decodeHtmlEntities(rawHref).replaceAll("\\", "");

  try {
    const url = new URL(decodedHref, productBaseUrl);
    const baseHost = new URL(productBaseUrl).hostname.replace(/^www\./i, "");
    const currentHost = url.hostname.replace(/^www\./i, "");

    if (!currentHost.endsWith(baseHost)) {
      return undefined;
    }

    if (!matchesProductPath(url.pathname, options)) {
      return undefined;
    }

    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return undefined;
  }
}

function matchesProductPath(
  pathname: string,
  options: PublicHtmlCatalogAdapterOptions,
): boolean {
  const pattern = options.productLinkPattern ?? /\/product\/[^\s"'<>\\]+/i;
  const testPattern = new RegExp(pattern.source, pattern.flags.replace("g", ""));

  return testPattern.test(pathname);
}

function extractProductChunk(
  html: string,
  productUrl: string,
  productBaseUrl: string,
): string {
  const url = new URL(productUrl, productBaseUrl);
  const needles = [
    url.toString(),
    url.pathname,
    url.pathname.replace(/^\//, ""),
    url.pathname.replace(/\//g, "\\/"),
  ];
  const index = needles
    .map((needle) => html.indexOf(needle))
    .find((position) => position >= 0);

  if (index === undefined) {
    return html.slice(0, 12_000);
  }

  return html.slice(Math.max(0, index - 4_000), index + 8_000);
}

function extractCandidateTitle(chunk: string): string | undefined {
  const titleFromAttributes = [
    readAttributeValue(chunk, "title"),
    readAttributeValue(chunk, "alt"),
    readAttributeValue(chunk, "aria-label"),
  ].find(isMeaningfulTitle);

  if (titleFromAttributes) {
    return titleFromAttributes;
  }

  const text = decodeHtmlEntities(stripTags(chunk)).replace(/\s+/g, " ").trim();
  const productLikeText = text
    .split(/(?:₽|руб\.?|В корзину|Добавить|Размер|Отзывы)/i)
    .map((part) => part.trim())
    .find(isMeaningfulTitle);

  return productLikeText ? productLikeText.slice(0, 160) : undefined;
}

function readAttributeValue(html: string, attributeName: string): string | undefined {
  const pattern = new RegExp(`${attributeName}=["']([^"']+)["']`, "i");
  const match = html.match(pattern);

  return match?.[1]
    ? decodeHtmlEntities(stripTags(match[1])).replace(/\s+/g, " ").trim()
    : undefined;
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

function extractImageUrls(html: string): string[] {
  const urls = new Set<string>();
  const normalizedHtml = normalizePublicHtml(html);
  const pattern =
    /(?:https?:)?\/\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi;

  for (const match of normalizedHtml.matchAll(pattern)) {
    const url = normalizeImageUrl(decodeHtmlEntities(match[0]));

    if (url) {
      urls.add(url);
    }
  }

  return [...urls];
}

function normalizeImageUrl(value: string): string | undefined {
  const normalized = value.startsWith("//") ? `https:${value}` : value;

  try {
    const url = new URL(normalized);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    return url.toString();
  } catch {
    return undefined;
  }
}

function isBlockedPublicHtmlPage(
  html: string,
  options: PublicHtmlCatalogAdapterOptions,
): boolean {
  const productPattern = options.productLinkPattern
    ? new RegExp(
        options.productLinkPattern.source,
        options.productLinkPattern.flags.replace("g", ""),
      )
    : /\/product\//i;
  const hasProductSignal =
    productPattern.test(html) ||
    /application\/ld\+json/i.test(html) ||
    /"@type"\s*:\s*"Product"/i.test(html) ||
    /"@type"\s*:\s*"ItemList"/i.test(html);
  const hardBlockPatterns = [/captcha/i, /anti[-\s]?bot/i, /access denied/i];
  const challengePatterns = [/__qrator/i, /\/__qrator\//i, /enable javascript/i];
  const patterns = [
    ...hardBlockPatterns,
    ...(!hasProductSignal ? challengePatterns : []),
    ...(options.blockedPagePatterns ?? []),
  ];

  return patterns.some((pattern) => pattern.test(html));
}

function buildPublicHtmlCatalogCacheKey(
  query: string,
  selection: MarketSearchSelection,
  marketConfig: PublicHtmlCatalogMarketConfig,
): string {
  return [
    "v1",
    normalizeCacheValue(marketConfig.publicSearchBaseUrl),
    normalizeCacheValue(query),
    normalizeCacheValue(selection.currency ?? "rub"),
    normalizeCacheValue(selection.locale ?? "ru"),
    normalizeCacheValue(selection.country ?? "ru"),
    normalizeCacheValue(selection.sort ?? ""),
    normalizeCacheValue(selection.category ?? ""),
    normalizeCacheValue((selection.categoryIds ?? []).join(",")),
    String(marketConfig.publicSearchPages),
  ].join("|");
}

function getPublicHtmlCatalogCacheEntry(
  state: PublicHtmlCatalogState,
  cacheKey: string,
  now: number,
  mode: "fresh" | "stale",
): PublicHtmlCatalogCacheEntry | undefined {
  const entry = state.cache.get(cacheKey);

  if (!entry) {
    return undefined;
  }

  if (now > entry.staleUntilMs) {
    state.cache.delete(cacheKey);
    return undefined;
  }

  if (mode === "fresh" && now > entry.expiresAtMs) {
    return undefined;
  }

  state.cache.delete(cacheKey);
  state.cache.set(cacheKey, entry);

  return entry;
}

function putPublicHtmlCatalogCacheEntry(
  state: PublicHtmlCatalogState,
  cacheKey: string,
  products: MarketProductRef[],
  marketConfig: PublicHtmlCatalogMarketConfig,
): void {
  const maxEntries = marketConfig.publicCacheMaxEntries;

  if (maxEntries <= 0) {
    return;
  }

  const now = Date.now();
  const expiresAtMs = now + marketConfig.publicCacheTtlMs;
  const staleUntilMs = expiresAtMs + marketConfig.publicCacheStaleTtlMs;

  state.cache.delete(cacheKey);
  state.cache.set(cacheKey, {
    products,
    expiresAtMs,
    staleUntilMs,
  });
  prunePublicHtmlCatalogCache(state, maxEntries);
}

function prunePublicHtmlCatalogCache(
  state: PublicHtmlCatalogState,
  maxEntries: number,
): void {
  const now = Date.now();

  for (const [cacheKey, entry] of state.cache) {
    if (now > entry.staleUntilMs) {
      state.cache.delete(cacheKey);
    }
  }

  while (state.cache.size > maxEntries) {
    const oldestKey = state.cache.keys().next().value;

    if (!oldestKey) {
      return;
    }

    state.cache.delete(oldestKey);
  }
}

function mergeCandidates(
  current: PublicHtmlCatalogCandidate | undefined,
  next: PublicHtmlCatalogCandidate,
): PublicHtmlCatalogCandidate {
  if (!current) {
    return next;
  }

  const images = uniqueStrings([
    ...(current.images ?? []),
    ...(next.images ?? []),
  ]);

  return {
    productUrl: current.productUrl,
    title: current.title ?? next.title,
    images: images.length ? images : undefined,
    price: current.price ?? next.price,
    brand: current.brand ?? next.brand,
    category: current.category ?? next.category,
  };
}

function shouldCooldownPublicHtmlCatalog(error: unknown): boolean {
  if (error instanceof MarketplaceError) {
    return error.retryable || /_api_(403|429|503)$/.test(error.code);
  }

  return (
    error instanceof Error &&
    /redirect|fetch failed|terminated|network|challenge/i.test(error.message)
  );
}

function normalizePrice(
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

function imageValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(isNonEmptyString).map((item) => item.trim());
  }

  return isNonEmptyString(value) ? [value.trim()] : [];
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

function titleFromProductUrl(
  productUrl: string,
  options: PublicHtmlCatalogAdapterOptions,
): string | undefined {
  const slug = extractProductSlug(productUrl, options);

  return slug
    ?.replace(/^\w{4,}\d*-/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function extractProductSlug(
  productUrl: string,
  options: PublicHtmlCatalogAdapterOptions,
): string | undefined {
  try {
    const url = new URL(productUrl);
    const segments = productPathSegments(url, options);

    return segments[0];
  } catch {
    return undefined;
  }
}

function extractGenericProductId(
  productUrl: string,
  options: PublicHtmlCatalogAdapterOptions,
): string | undefined {
  try {
    const url = new URL(productUrl);
    const segments = productPathSegments(url, options);

    if (segments.length >= 2 && /^\d+$/.test(segments.at(-1) ?? "")) {
      return segments.at(-1);
    }

    return segments[0]?.match(/^([a-z0-9]+)(?:-|$)/i)?.[1] ?? segments[0];
  } catch {
    return undefined;
  }
}

function productPathSegments(
  url: URL,
  options: PublicHtmlCatalogAdapterOptions,
): string[] {
  const segments = url.pathname.split("/").filter(Boolean);
  const productPathSegment = options.productPathSegment ?? "product";
  const productIndex = segments.findIndex(
    (segment) => segment === productPathSegment,
  );

  return productIndex >= 0 ? segments.slice(productIndex + 1) : [];
}

function normalizePublicHtml(html: string): string {
  return html
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
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

function isMeaningfulTitle(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  const normalized = value.trim();

  return (
    normalized.length >= 4 &&
    !/^https?:\/\//i.test(normalized) &&
    !/\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(normalized) &&
    !/^(image|фото|картинка|товар)$/i.test(normalized)
  );
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

function ensureGlobalFlags(pattern: RegExp): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;

  return flags.includes("i") ? flags : `${flags}i`;
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
