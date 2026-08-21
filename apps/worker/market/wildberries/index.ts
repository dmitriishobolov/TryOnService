import type { MarketProductRef } from "../../../shared/contracts/index.js";
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
  requireMarketCredential,
} from "../utils.js";

const provider = "wildberries";

export const wildberriesMarketplaceAdapter: MarketplaceAdapter = {
  provider,
  displayName: "Wildberries",
  isConfigured: (config) => Boolean(config.market.wildberries.apiKey),
  search: async ({
    query,
    selection,
    config,
    signal,
  }): Promise<MarketplaceSearchResult> => {
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
      .filter((product) => matchesPrice(product, selection.minPrice, selection.maxPrice));

    return {
      provider,
      products: limitProducts(products, limit),
    };
  },
};

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

