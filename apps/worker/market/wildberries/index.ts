import type { MarketProductRef } from "../../../shared/contracts/index.js";
import type { WorkerConfig } from "../../config/index.js";
import type { MarketplaceAdapter, MarketplaceSearchResult } from "../types.js";
import {
  collectNestedStringsByKeys,
  fetchMarketJson,
  findNestedStringByKeys,
  findStringByKeys,
  formatProductUrl,
  isRecord,
  limitProducts,
  matchesSearchQuery,
  numberFromUnknown,
  requireMarketCredential,
} from "../utils.js";

const provider = "wildberries";

export const wildberriesMarketplaceAdapter: MarketplaceAdapter = {
  provider,
  displayName: "Wildberries",
  isConfigured: (config) =>
    resolveWildberriesSearchMode(config) === "public" ||
    Boolean(config.market.wildberries.apiKey),
  search: async ({
    query,
    selection,
    config,
    signal,
  }): Promise<MarketplaceSearchResult> => {
    if (resolveWildberriesSearchMode(config) === "public") {
      return searchPublicWildberries({
        query,
        selection,
        config,
        signal,
      });
    }

    return searchSellerWildberries({
      query,
      selection,
      config,
      signal,
    });
  },
};

async function searchSellerWildberries({
  query,
  selection,
  config,
  signal,
}: Parameters<MarketplaceAdapter["search"]>[0]): Promise<MarketplaceSearchResult> {
  const marketConfig = config.market.wildberries;
  const apiKey = requireMarketCredential(
    provider,
    "WILDBERRIES_API_KEY",
    marketConfig.apiKey,
  );
  const limit = Math.min(selection.limit ?? config.market.searchLimit, 100);
  const response = await fetchMarketJson<unknown>(
    provider,
    `${marketConfig.baseUrl.replace(/\/+$/, "")}${marketConfig.cardsListPath}`,
    {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        settings: {
          cursor: {
            limit: marketConfig.maxScanCards,
          },
          filter: {
            textSearch: selection.category,
            withPhoto: marketConfig.withPhoto ? 1 : -1,
          },
        },
      }),
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );
  const products = parseWildberriesProducts(
    response,
    marketConfig.productUrlTemplate,
  )
    .filter((product) => matchesSearchQuery(product, query))
    .filter((product) =>
      matchesPrice(product, selection.minPrice, selection.maxPrice),
    );

  return {
    provider,
    products: limitProducts(products, limit),
  };
}

async function searchPublicWildberries({
  query,
  selection,
  config,
  signal,
}: Parameters<MarketplaceAdapter["search"]>[0]): Promise<MarketplaceSearchResult> {
  const marketConfig = config.market.wildberries;
  const limit = Math.min(selection.limit ?? config.market.searchLimit, 100);
  const url = new URL(
    `${marketConfig.publicSearchBaseUrl.replace(/\/+$/, "")}${marketConfig.publicSearchPath}`,
  );

  url.searchParams.set("ab_testing", "false");
  url.searchParams.set("appType", "1");
  url.searchParams.set("curr", selection.currency ?? "rub");
  url.searchParams.set("dest", marketConfig.publicDest);
  url.searchParams.set("lang", marketConfig.locale);
  url.searchParams.set("locale", marketConfig.locale);
  url.searchParams.set("page", "1");
  url.searchParams.set("query", query);
  url.searchParams.set("resultset", "catalog");
  url.searchParams.set("sort", selection.sort ?? marketConfig.publicSort);
  url.searchParams.set("spp", String(marketConfig.publicSpp));
  url.searchParams.set("suppressSpellcheck", "false");

  const response = await fetchMarketJson<unknown>(
    provider,
    url.toString(),
    {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        Origin: "https://www.wildberries.ru",
        Referer: "https://www.wildberries.ru/",
        "User-Agent": marketConfig.publicUserAgent,
      },
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );
  const products = parseWildberriesPublicProducts(
    response,
    marketConfig.productUrlTemplate,
  )
    .filter((product) => matchesSearchQuery(product, query))
    .filter((product) =>
      matchesPrice(product, selection.minPrice, selection.maxPrice),
    );

  return {
    provider,
    products: limitProducts(products, limit),
  };
}

function resolveWildberriesSearchMode(config: WorkerConfig): "seller" | "public" {
  const mode = config.market.wildberries.searchMode;

  if (mode === "seller") {
    return "seller";
  }

  if (mode === "public") {
    return "public";
  }

  return config.market.wildberries.apiKey ? "seller" : "public";
}

function parseWildberriesProducts(
  response: unknown,
  productUrlTemplate: string,
): MarketProductRef[] {
  const cards = findNestedRecordsByKeys(response, ["cards"]) ?? [];

  return cards
    .map((card) => normalizeWildberriesCard(card, productUrlTemplate))
    .filter((product): product is MarketProductRef => Boolean(product));
}

function normalizeWildberriesCard(
  card: Record<string, unknown>,
  productUrlTemplate: string,
): MarketProductRef | undefined {
  const productId = findStringByKeys(card, ["nmID", "nmId", "imtID", "imtId"]);
  const title = findStringByKeys(card, ["title", "name"]);

  if (!productId || !title) {
    return undefined;
  }

  const images = collectNestedStringsByKeys(card, [
    "big",
    "c516x688",
    "c246x328",
    "square",
    "tm",
    "url",
  ]).filter(isHttpUrl);
  const price = resolveWildberriesPrice(card);

  return {
    provider,
    productId,
    title,
    productUrl: formatProductUrl(productUrlTemplate, {
      nmId: productId,
      nmID: productId,
      imtId: findStringByKeys(card, ["imtID", "imtId"]),
    }),
    imageUrl: images[0],
    images: images.length ? images : undefined,
    price,
    brand: findStringByKeys(card, ["brand"]),
    category:
      findStringByKeys(card, ["subjectName"]) ??
      findStringByKeys(card, ["object", "parentName"]),
  };
}

function parseWildberriesPublicProducts(
  response: unknown,
  productUrlTemplate: string,
): MarketProductRef[] {
  const products =
    findNestedRecordsByKeys(response, ["products"]) ??
    findNestedRecordsByKeys(response, ["items"]) ??
    [];

  return products
    .map((product) =>
      normalizeWildberriesPublicProduct(product, productUrlTemplate),
    )
    .filter((product): product is MarketProductRef => Boolean(product));
}

function normalizeWildberriesPublicProduct(
  product: Record<string, unknown>,
  productUrlTemplate: string,
): MarketProductRef | undefined {
  const productId = findStringByKeys(product, ["id", "nmId", "nmID", "root"]);
  const title = findStringByKeys(product, ["name", "title"]);

  if (!productId || !title) {
    return undefined;
  }

  const responseImages = collectNestedStringsByKeys(product, [
    "imageUrl",
    "image",
    "url",
    "big",
    "c516x688",
    "c246x328",
    "square",
  ]).filter(isHttpUrl);
  const generatedImages = buildWildberriesImageUrls(productId);
  const images = responseImages.length ? responseImages : generatedImages;

  return {
    provider,
    productId,
    title,
    productUrl: formatProductUrl(productUrlTemplate, {
      nmId: productId,
      nmID: productId,
      imtId: findStringByKeys(product, ["root", "subjectId"]),
    }),
    imageUrl: images[0],
    images: images.length ? images : undefined,
    price: resolveWildberriesPublicPrice(product),
    brand: findStringByKeys(product, ["brand", "brandName"]),
    category: findStringByKeys(product, [
      "subjectName",
      "subject",
      "kindName",
      "entity",
    ]),
  };
}

function resolveWildberriesPrice(
  card: Record<string, unknown>,
): MarketProductRef["price"] {
  const price =
    findNestedStringByKeys(card, ["price"]) ??
    findNestedStringByKeys(card, ["priceU"]) ??
    findNestedStringByKeys(card, ["discountedPrice"]);

  if (!price) {
    return undefined;
  }

  const parsed = Number(price);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  const amount = price.endsWith("00") && parsed > 10_000 ? parsed / 100 : parsed;

  return {
    amount,
    currency: "RUB",
  };
}

function resolveWildberriesPublicPrice(
  product: Record<string, unknown>,
): MarketProductRef["price"] {
  const rawPrice =
    findNestedStringByKeys(product, ["salePriceU"]) ??
    findNestedStringByKeys(product, ["salePrice"]) ??
    findNestedStringByKeys(product, ["priceU"]) ??
    findNestedStringByKeys(product, ["price"]) ??
    findNestedStringByKeys(product, ["total"]) ??
    findNestedStringByKeys(product, ["basic"]) ??
    findNestedStringByKeys(product, ["product"]);
  const parsed = numberFromUnknown(rawPrice);

  if (parsed === undefined) {
    return undefined;
  }

  return {
    amount: parsed > 10_000 ? parsed / 100 : parsed,
    currency: "RUB",
  };
}

function buildWildberriesImageUrls(productId: string): string[] {
  const numericId = Number(productId);

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return [];
  }

  const vol = Math.floor(numericId / 100_000);
  const part = Math.floor(numericId / 1_000);
  const basket = wildberriesBasketHost(vol);
  const basePath = `https://${basket}/vol${vol}/part${part}/${numericId}/images`;

  return [
    `${basePath}/c516x688/1.webp`,
    `${basePath}/big/1.webp`,
    `${basePath}/c516x688/1.jpg`,
    `${basePath}/big/1.jpg`,
  ];
}

function wildberriesBasketHost(vol: number): string {
  const ranges: Array<[number, number]> = [
    [0, 143],
    [144, 287],
    [288, 431],
    [432, 719],
    [720, 1007],
    [1008, 1061],
    [1062, 1115],
    [1116, 1169],
    [1170, 1313],
    [1314, 1601],
    [1602, 1655],
    [1656, 1919],
    [1920, 2045],
    [2046, 2189],
    [2190, 2405],
    [2406, 2621],
    [2622, 2837],
    [2838, 3053],
    [3054, 3269],
    [3270, 3485],
    [3486, 3701],
    [3702, 3917],
    [3918, 4133],
    [4134, 4349],
    [4350, 4565],
    [4566, 4781],
    [4782, 4997],
    [4998, 5213],
    [5214, 5429],
    [5430, 5645],
  ];
  const index = ranges.findIndex(([min, max]) => vol >= min && vol <= max);
  const basketNumber =
    index >= 0 ? index + 1 : Math.max(1, Math.ceil((vol + 1) / 216));

  return `basket-${String(basketNumber).padStart(2, "0")}.wbbasket.ru`;
}

function findNestedRecordsByKeys(
  value: unknown,
  keys: string[],
): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const current = value[key];

    if (Array.isArray(current)) {
      return current.filter(isRecord);
    }

    if (isRecord(current)) {
      const nested = findNestedRecordsByKeys(current, keys);

      if (nested) {
        return nested;
      }
    }
  }

  for (const current of Object.values(value)) {
    const nested = findNestedRecordsByKeys(current, keys);

    if (nested) {
      return nested;
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

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
