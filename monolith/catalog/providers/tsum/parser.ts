import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { MonolithConfig, MonolithTsumProductEnrichment } from "../../../config.js";
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
  productEnrichment?: MonolithTsumProductEnrichment;
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

interface TsumProductPage {
  url: string;
  title: string;
  status?: number;
  product?: JsonObject;
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
  const productEnrichment = options.productEnrichment ?? config.catalog.tsumProductEnrichment;

  logger.info("Monolith TSUM catalog read started", {
    url,
    gender,
    startPage,
    productEnrichment,
  });

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
      const baseItems = itemLimit > 0 ? normalized.slice(0, remaining) : normalized;
      const items = await enrichTsumItemsIfNeeded(browser, baseItems, config, productEnrichment);

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


async function enrichTsumItemsIfNeeded(
  browser: Browser,
  items: GarmentCatalogItem[],
  config: MonolithConfig,
  productEnrichment: MonolithTsumProductEnrichment,
): Promise<GarmentCatalogItem[]> {
  if (productEnrichment === "off" || items.length === 0) {
    return items;
  }

  const jobs = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => shouldEnrichTsumItem(item, productEnrichment));

  if (jobs.length === 0) {
    return items;
  }

  const results = [...items];
  const concurrency = Math.min(
    Math.max(1, Math.floor(config.catalog.tsumProductConcurrency)),
    jobs.length,
  );
  const delayMs = config.catalog.tsumProductPageDelayMs;
  const firstWaveStaggerMs = Math.min(250, delayMs);
  let nextJobIndex = 0;
  let visitedProductPages = 0;
  let failedProductPages = 0;
  const failedItemIds: string[] = [];

  if (concurrency === 1) {
    const page = await browser.newPage({
      userAgent: config.catalog.userAgent,
    });

    try {
      for (const { item, index } of jobs) {
        if (visitedProductPages > 0 && delayMs > 0) {
          await sleep(delayMs);
        }

        visitedProductPages += 1;

        try {
          const productPage = await readTsumProductPageWithRetries(page, item.productUrl, config, item.id);
          const product = productPage.product;

          if (!product) {
            failedProductPages += 1;
            failedItemIds.push(item.id);
            continue;
          }

          results[index] = mergeTsumProductPageItem(item, product, productPage.url);
        } catch (error) {
          failedProductPages += 1;
          failedItemIds.push(item.id);
          logger.debug("Monolith TSUM product enrichment failed", {
            itemId: item.id,
            productUrl: item.productUrl,
            error: errorMessage(error),
          });
        }
      }
    } finally {
      await page.close().catch((error: unknown) => {
        logger.debug("Monolith TSUM sequential product enrichment page close failed", {
          error: errorMessage(error),
        });
      });
    }

    const summary = {
      items: items.length,
      productEnrichment,
      concurrency,
      visitedProductPages,
      failedProductPages,
      sampleFailedItemIds: failedItemIds.slice(0, 8),
    };

    if (failedProductPages > 0) {
      logger.warn("Monolith TSUM product enrichment batch finished with failures", summary);
    } else {
      logger.debug("Monolith TSUM product enrichment batch finished", summary);
    }

    return results;
  }

  const runWorker = async (workerIndex: number): Promise<void> => {
    const context = await createTsumProductEnrichmentContext(browser, config);
    const page = await context.newPage();
    let workerVisitedProductPages = 0;

    try {
      if (workerIndex > 0 && firstWaveStaggerMs > 0) {
        await sleep(workerIndex * firstWaveStaggerMs);
      }

      while (true) {
        const jobIndex = nextJobIndex;
        nextJobIndex += 1;

        if (jobIndex >= jobs.length) {
          break;
        }

        const { item, index } = jobs[jobIndex];

        if (workerVisitedProductPages > 0 && delayMs > 0) {
          await sleep(delayMs);
        }

        visitedProductPages += 1;
        workerVisitedProductPages += 1;

        try {
          const productPage = await readTsumProductPageWithRetries(page, item.productUrl, config, item.id);
          const product = productPage.product;

          if (!product) {
            failedProductPages += 1;
            failedItemIds.push(item.id);
            continue;
          }

          results[index] = mergeTsumProductPageItem(item, product, productPage.url);
        } catch (error) {
          failedProductPages += 1;
          failedItemIds.push(item.id);
          logger.debug("Monolith TSUM product enrichment failed", {
            itemId: item.id,
            productUrl: item.productUrl,
            error: errorMessage(error),
          });
        }
      }
    } finally {
      await context.close().catch((error: unknown) => {
        logger.debug("Monolith TSUM product enrichment context close failed", {
          workerIndex,
          error: errorMessage(error),
        });
      });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, index) => runWorker(index)));

  const summary = {
    items: items.length,
    productEnrichment,
    concurrency,
    visitedProductPages,
    failedProductPages,
    sampleFailedItemIds: failedItemIds.slice(0, 8),
  };

  if (failedProductPages > 0) {
    logger.warn("Monolith TSUM product enrichment batch finished with failures", summary);
  } else {
    logger.debug("Monolith TSUM product enrichment batch finished", summary);
  }

  return results;
}

async function createTsumProductEnrichmentContext(
  browser: Browser,
  config: MonolithConfig,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    userAgent: config.catalog.userAgent,
  });

  await context.route("**/*", async (route) => {
    const resourceType = route.request().resourceType();

    if (resourceType === "image" || resourceType === "media" || resourceType === "font" || resourceType === "stylesheet") {
      await route.abort().catch(() => undefined);
      return;
    }

    await route.continue().catch(() => undefined);
  });

  return context;
}

function shouldEnrichTsumItem(
  item: GarmentCatalogItem,
  productEnrichment: MonolithTsumProductEnrichment,
): boolean {
  return productEnrichment === "all" || item.sizes.length === 0 || item.colors.length === 0;
}

async function readTsumProductPageWithRetries(
  page: Page,
  url: string,
  config: MonolithConfig,
  itemId: string,
): Promise<TsumProductPage> {
  const attempts = Math.max(1, config.catalog.tsumProductPageRetryAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await readTsumProductPage(page, url, config);

      if (result.product) {
        return result;
      }

      throw new Error("TSUM product state is missing");
    } catch (error) {
      lastError = error;

      if (attempt >= attempts) {
        break;
      }

      await sleep(config.catalog.tsumProductRetryDelayMs * attempt);
    }
  }

  throw new Error(
    "Failed to enrich TSUM product " + itemId + ": " + errorMessage(lastError),
  );
}

async function readTsumProductPage(
  page: Page,
  url: string,
  config: MonolithConfig,
): Promise<TsumProductPage> {
  const response = await page.goto(url, {
    waitUntil: config.catalog.browserWaitUntil,
    timeout: config.catalog.tsumProductPageTimeoutMs,
  });
  const html = await page.content();
  const state = readInitialState(html);
  const product = state ? readTsumProductPageProduct(state, url) : undefined;

  return {
    url: page.url(),
    title: await page.title(),
    status: response?.status(),
    product,
  };
}

function readTsumProductPageProduct(
  state: JsonObject,
  pageUrl: string,
): JsonObject | undefined {
  const productRoot = asObject(asObject(state.product)?.product);
  const slug = filenameFromUrl(pageUrl);

  if (!productRoot) {
    return undefined;
  }

  const bySlug = slug ? asObject(productRoot[slug]) : undefined;
  const nestedBySlug = asObject(bySlug?.product);

  if (nestedBySlug && looksLikeTsumProductPageProduct(nestedBySlug)) {
    return nestedBySlug;
  }

  if (bySlug && looksLikeTsumProductPageProduct(bySlug)) {
    return bySlug;
  }

  for (const value of Object.values(productRoot)) {
    const object = asObject(value);
    const nested = asObject(object?.product);

    if (nested && looksLikeTsumProductPageProduct(nested)) {
      return nested;
    }

    if (object && looksLikeTsumProductPageProduct(object)) {
      return object;
    }
  }

  return undefined;
}

function looksLikeTsumProductPageProduct(value: JsonObject): boolean {
  return Boolean(
    readFirstString(value.title, value.name) &&
    (asArray(value.offers) || asArray(value.products) || asObject(value.color)),
  );
}

function mergeTsumProductPageItem(
  item: GarmentCatalogItem,
  product: JsonObject,
  pageUrl: string,
): GarmentCatalogItem {
  const pageSizes = readTsumProductPageAvailableSizes(product);
  const pageColors = readTsumProductPageColors(product);
  const sizes = pageSizes.length > 0 ? pageSizes : item.sizes;
  const colors = pageColors.length > 0 ? uniqueStrings([...item.colors, ...pageColors]) : item.colors;
  const price = item.price ?? readTsumPrice(product);
  const imageUrl = item.imageUrl || readTsumImageUrl(product, pageUrl) || "";
  const brandName = readFirstString(
    product.brand_name,
    product.brandName,
    asObject(product.brand)?.title,
    asObject(product.brand)?.name,
  );
  const imageAlt = stringValue(product.image_alt);
  const season = stringValue(product.season);
  const categoryType = stringValue(product.categoryType);
  const description = buildTsumDescription({
    title: item.title,
    brandName,
    category: item.category,
    colors,
    sizes,
    price,
    imageAlt,
    season,
    categoryType,
  }) ?? item.description;

  return {
    ...item,
    sizes,
    colors,
    price,
    imageUrl,
    description,
    tags: uniqueStrings([
      ...item.tags,
      brandName,
      imageAlt,
      season,
      categoryType,
      ...sizes,
      ...colors,
      ...readTagTitles(product.tags),
    ].filter((value): value is string => Boolean(value && isUsefulTsumSearchTag(value)))),
    updatedAt: new Date().toISOString(),
  };
}

function readTsumProductPageColors(product: JsonObject): string[] {
  return uniqueStrings([
    ...readTsumColors(product),
    ...readObjectArray(product.products).flatMap((variant) => readTsumColors(variant)),
    ...readObjectArray(product.productList).flatMap((variant) => readTsumColors(variant)),
    ...readObjectArray(product.colorVariants).flatMap((variant) => readTsumColors(variant)),
  ].filter((value) => isHumanReadableColor(value)));
}

function readTsumProductPageAvailableSizes(product: JsonObject): string[] {
  const offers = [
    ...readObjectArray(product.offers),
    ...readObjectArray(product.skuList),
  ];
  const availableOffers = offers.filter((offer) => isTsumOfferAvailable(offer));
  const availableSizes = uniqueStrings(availableOffers.flatMap((offer) => readSizeValues(offer)));

  if (availableSizes.length > 0) {
    return availableSizes;
  }

  const offerSizes = uniqueStrings(offers.flatMap((offer) => readSizeValues(offer)));

  if (offerSizes.length > 0) {
    return offerSizes;
  }

  return readTsumSizes(product);
}

function isTsumOfferAvailable(offer: JsonObject): boolean {
  const isBuyable = booleanValue(offer.isBuyable) ?? booleanValue(offer.is_buyable);
  const inStock = booleanValue(offer.availabilityInStock) ?? booleanValue(offer.inStock);
  const quantity = readFirstNumber(offer.quantity, offer.availableQuantity, offer.stock);

  if (isBuyable === false || inStock === false) {
    return false;
  }

  if (quantity !== undefined) {
    return quantity > 0;
  }

  return true;
}

function normalizeTsumProduct(
  product: JsonObject,
  pageUrl: string,
  gender: GarmentGender,
): GarmentCatalogItem[] {
  const slug = readFirstString(product.slug, product.code, product.url_code, product.urlCode);
  const title = readFirstString(product.title, product.name);
  const externalId = readFirstScalarString(
    product.ext_id,
    product.external_id,
    product.product_id,
    product.productId,
    product.id,
    product.code,
    slug,
  );
  const productUrl = readTsumProductUrl(product, slug, pageUrl);
  const categorySlug = readFirstString(
    product.category_slug,
    product.categorySlug,
    asObject(product.category)?.slug,
    asObject(product.section)?.slug,
  );
  const imageUrl = readTsumImageUrl(product, pageUrl) ?? "";

  if (!externalId || !title || !productUrl) {
    logger.debug("Monolith TSUM product skipped because required table fields are missing", {
      externalId,
      title,
      productUrl,
      hasImage: Boolean(imageUrl),
    });
    return [];
  }

  const brandName = readFirstString(
    product.brand_name,
    product.brandName,
    asObject(product.brand)?.title,
    asObject(product.brand)?.name,
  );
  const colors = readTsumColors(product);
  const sizes = readTsumSizes(product);
  const price = readTsumPrice(product);
  const imageAlt = stringValue(product.image_alt);
  const season = stringValue(product.season);
  const categoryType = stringValue(product.categoryType);
  const category = inferCategory([
    categorySlug,
    title,
    imageAlt,
    categoryType,
    ...readTagTitles(product.tags),
  ].filter((item): item is string => Boolean(item)).join(" "));
  const description = buildTsumDescription({
    title,
    brandName,
    category,
    colors,
    sizes,
    price,
    imageAlt,
    season,
    categoryType,
  });
  const now = new Date().toISOString();

  return [
    {
      id: "tsum:" + externalId,
      category,
      gender,
      title,
      description,
      sizes,
      colors,
      price,
      tags: uniqueStrings([
        "цум",
        "tsum",
        gender,
        brandName,
        title,
        category,
        categorySlug,
        imageAlt,
        season,
        categoryType,
        ...sizes,
        ...colors,
        ...readTagTitles(product.tags),
      ].filter((item): item is string => Boolean(item && isUsefulTsumSearchTag(item)))),
      productUrl,
      imageUrl,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export async function downloadCatalogImage(
  item: GarmentCatalogItem,
  config: MonolithConfig,
): Promise<{ image: Buffer; contentType: string }> {
  if (!item.imageUrl) {
    throw new Error("Catalog item does not have imageUrl");
  }

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
    throw new Error("Catalog image download failed with " + response.status);
  }

  return {
    image: await readResponseBuffer(response, config.maxDownloadBytes),
    contentType: response.headers.get("content-type") ?? contentTypeFromFilename(filenameFromUrl(item.imageUrl) ?? item.id + ".jpg"),
  };
}

function chooseTsumImageUrl(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }

  const direct = stringValue(value);

  if (direct) {
    return direct;
  }

  const items = asArray(value);

  if (items) {
    for (const item of items) {
      const found = chooseTsumImageUrl(item, depth + 1);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  const object = asObject(value);

  if (!object) {
    return undefined;
  }

  for (const field of TSUM_PRODUCT_IMAGE_FIELDS) {
    const found = chooseTsumImageUrl(object[field], depth + 1);

    if (found) {
      return found;
    }
  }

  for (const field of ["url", "src", "href", "path", "image", "imageUrl", "image_url", "photo", "picture"]) {
    const found = chooseTsumImageUrl(object[field], depth + 1);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function readTsumImageUrl(product: JsonObject, pageUrl: string): string | undefined {
  const raw = chooseTsumImageUrl(product.photos) ??
    chooseTsumImageUrl(product.images) ??
    chooseTsumImageUrl(product.gallery) ??
    chooseTsumImageUrl(product.image) ??
    chooseTsumImageUrl(product.imageUrl) ??
    chooseTsumImageUrl(product.image_url) ??
    chooseTsumImageUrl(product.picture) ??
    chooseTsumImageUrl(product.photo);

  return raw ? absolutizeTsumUrl(raw, pageUrl) : undefined;
}

function readTsumProductUrl(
  product: JsonObject,
  slug: string | undefined,
  pageUrl: string,
): string | undefined {
  const explicit = readFirstString(
    product.productUrl,
    product.product_url,
    product.url,
    product.link,
    product.href,
  );

  if (explicit) {
    return absolutizeTsumUrl(explicit, pageUrl);
  }

  return slug ? new URL("/product/" + slug + "/", pageUrl).toString() : undefined;
}

function inferCategory(value: string): string {
  return inferCategoryFromText(value) ?? "другое";
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
    [/kombinezon|jumpsuit|overall|комбинезон/, "комбинезон"],
    [/rubash|shirt|сорочк|рубаш|bluzy|блуз/, "рубашка"],
    [/bryuk|trouser|pants|slacks|chino|чинос|брюк|джоггер|штан/, "брюки"],
    [/longsliv|лонгслив/, "лонгслив"],
    [/futbol|t-shirt|tee|футбол|тиширт/, "футболка"],
    [/dzhins|jeans|джинс/, "джинсы"],
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

function readTsumColors(product: JsonObject): string[] {
  const colorConcrete = asObject(product.colorConcrete);
  const color = asObject(product.color);
  const readable = uniqueStrings([
    stringValue(colorConcrete?.title),
    stringValue(colorConcrete?.name),
    stringValue(color?.title),
    stringValue(color?.name),
    stringValue(product.color_title),
    stringValue(product.colorTitle),
    stringValue(product.color_name),
    stringValue(product.colorName),
    ...readTagTitles(product.colors),
    ...readTagTitles(product.colorList),
  ].filter((item): item is string => Boolean(item && isHumanReadableColor(item))));

  if (readable.length > 0) {
    return readable;
  }

  return uniqueStrings([
    stringValue(product.color_code),
    stringValue(product.colorCode),
  ].filter((item): item is string => Boolean(item && isHumanReadableColor(item))));
}

function isHumanReadableColor(value: string): boolean {
  const normalized = value.trim();

  return Boolean(
    normalized &&
    normalized.length <= 32 &&
    !normalized.includes("_") &&
    !/\d{3,}/.test(normalized)
  );
}

function isUsefulTsumSearchTag(value: string | undefined): boolean {
  const normalized = value?.trim();

  return Boolean(
    normalized &&
    normalized.length <= 80 &&
    !normalized.includes("_") &&
    normalized.toLowerCase() !== "clothes" &&
    normalized.toLowerCase() !== "fashion_show" &&
    normalized.toLowerCase() !== "fashion show" &&
    !/^[-_a-zа-яё]+-[0-9]+$/i.test(normalized) &&
    !/^[0-9]+$/.test(normalized)
  );
}

function readTsumPrice(product: JsonObject): GarmentCatalogItem["price"] {
  const skuList = readObjectArray(product.skuList);
  const discounted = [
    ...readPriceValues(product, ["price_discount", "priceDiscount", "discountPrice", "sale_price", "price_sale", "current_price", "currentPrice", "min_price", "minPrice", "price"]),
    ...skuList.flatMap((sku) => readPriceValues(sku, ["price_discount", "priceDiscount", "discountPrice", "sale_price", "price_sale", "current_price", "currentPrice", "price"])),
  ];
  const original = [
    ...readPriceValues(product, ["price_original", "priceOriginal", "old_price", "oldPrice", "price_old", "retail_price", "retailPrice"]),
    ...skuList.flatMap((sku) => readPriceValues(sku, ["price_original", "priceOriginal", "old_price", "oldPrice", "price_old", "retail_price", "retailPrice"])),
  ];
  const amount = discounted.length
    ? Math.min(...discounted)
    : original.length
      ? Math.min(...original)
      : undefined;

  if (!amount || amount <= 0) {
    return undefined;
  }

  const oldAmount = original.length ? Math.max(...original) : undefined;

  return {
    amount,
    currency: "RUB",
    ...(oldAmount && oldAmount > amount ? { oldAmount } : {}),
  };
}

function readPriceValues(product: JsonObject, fields: string[]): number[] {
  return fields
    .flatMap((field) => [numberValue(product[field])])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function readTsumSizes(product: JsonObject): string[] {
  return uniqueStrings([
    ...readObjectArray(product.skuList).flatMap((sku) => readSizeValues(sku)),
    ...readObjectArray(product.offers).flatMap((offer) => readSizeValues(offer)),
    ...readObjectArray(product.sizes).flatMap((size) => readSizeValues(size)),
    ...readObjectArray(product.sizeList).flatMap((size) => readSizeValues(size)),
    ...readLooseStringArray(product.sizes),
    ...readLooseStringArray(product.sizeList),
    ...readLooseStringArray(product.availableSizes),
    ...readLooseStringArray(product.size),
  ]);
}

function readSizeValues(value: JsonObject): string[] {
  const size = asObject(value.size);
  const sizeAttributes = asObject(value.sizeAttributes);

  return uniqueStrings([
    stringValue(value.size_title),
    stringValue(value.size_name),
    stringValue(value.sizeName),
    stringValue(value.techSize),
    stringValue(value.tech_size),
    stringValue(value.russianSize),
    stringValue(value.vendorSize),
    stringValue(value.russian_size),
    stringValue(value.vendor_size),
    stringValue(value.title),
    stringValue(value.name),
    stringValue(value.value),
    stringValue(size?.title),
    stringValue(size?.name),
    stringValue(size?.value),
    stringValue(size?.techSize),
    stringValue(size?.tech_size),
    stringValue(size?.russianSize),
    stringValue(size?.vendorSize),
    stringValue(size?.russian_size),
    stringValue(size?.vendor_size),
    stringValue(sizeAttributes?.title),
    stringValue(sizeAttributes?.name),
    stringValue(sizeAttributes?.value),
    stringValue(sizeAttributes?.techSize),
    stringValue(sizeAttributes?.tech_size),
    stringValue(sizeAttributes?.russianSize),
    stringValue(sizeAttributes?.vendorSize),
    stringValue(sizeAttributes?.russian_size),
    stringValue(sizeAttributes?.vendor_size),
    scalarString(value.size),
  ].filter((item): item is string => Boolean(item && !/^\d{4,}$/.test(item))));
}

function readTagTitles(value: unknown): string[] {
  return uniqueStrings(readObjectArray(value).flatMap((item) => [
    stringValue(item.title),
    stringValue(item.name),
    stringValue(item.slug),
    stringValue(item.value),
    scalarString(item.code),
  ]).filter((item): item is string => Boolean(item)));
}

function buildTsumDescription(details: {
  title: string;
  brandName?: string;
  category: string;
  colors: string[];
  sizes: string[];
  price?: GarmentCatalogItem["price"];
  imageAlt?: string;
  season?: string;
  categoryType?: string;
}): string | undefined {
  const priceText = details.price ? String(details.price.amount) + " " + details.price.currency : undefined;

  return uniqueStrings([
    details.imageAlt,
    details.brandName,
    details.category,
    details.colors.length ? "цвет: " + details.colors.join(", ") : undefined,
    details.sizes.length ? "размеры: " + details.sizes.slice(0, 12).join(", ") : undefined,
    details.season,
    isUsefulTsumSearchTag(details.categoryType) ? details.categoryType : undefined,
    priceText,
  ].filter((item): item is string => Boolean(item && item !== details.title))).join("; ") || undefined;
}

function readLooseStringArray(value: unknown): string[] {
  const direct = scalarString(value);

  if (direct) {
    return [direct];
  }

  return (asArray(value) ?? [])
    .flatMap((item) => scalarString(item) ? [scalarString(item) as string] : [])
    .filter((item) => !/^\d{4,}$/.test(item));
}

function readFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringValue(value);

    if (result) {
      return result;
    }
  }

  return undefined;
}

function readFirstScalarString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = scalarString(value);

    if (result) {
      return result;
    }
  }

  return undefined;
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
    const noSpaces = value.replace(/\s+/g, "");
    const numeric = noSpaces.replace(/[^\d,.-]+/g, "");
    const normalized = numeric.includes(".")
      ? numeric.replace(/,/g, "")
      : numeric.replace(/,/g, ".");
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const object = asObject(value);

  if (object) {
    return readFirstNumber(object.amount, object.value, object.price, object.text);
  }

  return undefined;
}

function readFirstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const result = numberValue(value);

    if (Number.isFinite(result)) {
      return result;
    }
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