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
  priceFromUnknown,
  requireMarketCredential,
} from "../utils.js";

const provider = "ozon";

export const ozonMarketplaceAdapter: MarketplaceAdapter = {
  provider,
  displayName: "Ozon",
  isConfigured: (config) =>
    Boolean(config.market.ozon.clientId && config.market.ozon.apiKey),
  search: async ({
    query,
    selection,
    config,
    signal,
  }): Promise<MarketplaceSearchResult> => {
    const marketConfig = config.market.ozon;
    const clientId = requireMarketCredential(
      provider,
      "OZON_CLIENT_ID",
      marketConfig.clientId,
    );
    const apiKey = requireMarketCredential(
      provider,
      "OZON_API_KEY",
      marketConfig.apiKey,
    );
    const headers = {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    };
    const limit = Math.min(selection.limit ?? config.market.searchLimit, 100);
    const ids = await fetchOzonProductIds({
      config,
      headers,
      signal,
    });

    if (ids.length === 0) {
      return { provider, products: [] };
    }

    const info = await fetchMarketJson<unknown>(
      provider,
      `${marketConfig.baseUrl.replace(/\/+$/, "")}${marketConfig.productInfoListPath}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          product_id: ids.slice(0, marketConfig.maxScanProducts),
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const products = parseOzonProducts(info, marketConfig.productUrlTemplate)
      .filter((product) => matchesSearchQuery(product, query))
      .filter((product) => matchesPrice(product, selection.minPrice, selection.maxPrice));

    return {
      provider,
      products: limitProducts(products, limit),
    };
  },
};

async function fetchOzonProductIds(params: {
  config: WorkerConfig;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<number[]> {
  const marketConfig = params.config.market.ozon;
  const response = await fetchMarketJson<unknown>(
    provider,
    `${marketConfig.baseUrl.replace(/\/+$/, "")}${marketConfig.productListPath}`,
    {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify({
        filter: {
          visibility: marketConfig.visibility,
        },
        limit: Math.min(marketConfig.maxScanProducts, 1000),
      }),
    },
    params.config.tryOnModelHttpTimeoutMs,
    params.signal,
  );
  const items = findOzonItems(response);

  return items
    .map((item) => Number(findStringByKeys(item, ["product_id", "productId", "id"])))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function parseOzonProducts(
  response: unknown,
  productUrlTemplate: string,
): MarketProductRef[] {
  return findOzonItems(response)
    .map((item) => normalizeOzonProduct(item, productUrlTemplate))
    .filter((product): product is MarketProductRef => Boolean(product));
}

function findOzonItems(response: unknown): Record<string, unknown>[] {
  const items =
    findNestedRecordsByKeys(response, ["items"]) ??
    findNestedRecordsByKeys(response, ["products"]) ??
    findNestedRecordsByKeys(response, ["result"]) ??
    [];

  return items;
}

function normalizeOzonProduct(
  item: Record<string, unknown>,
  productUrlTemplate: string,
): MarketProductRef | undefined {
  const productId = findStringByKeys(item, [
    "product_id",
    "productId",
    "id",
    "offer_id",
    "offerId",
    "sku",
  ]);
  const title = findStringByKeys(item, ["name", "title", "product_name"]);

  if (!productId || !title) {
    return undefined;
  }

  const sku = findStringByKeys(item, ["sku", "fbo_sku", "fbs_sku"]);
  const images = collectNestedStringsByKeys(item, [
    "primary_image",
    "primaryImage",
    "image",
    "image_url",
    "imageUrl",
    "file_name",
    "url",
  ]).filter(isHttpUrl);
  const currency = findNestedStringByKeys(item, [
    "currency_code",
    "currencyCode",
    "currency",
  ]);
  const price =
    priceFromUnknown(findNestedStringByKeys(item, ["marketing_price"]), currency) ??
    priceFromUnknown(findNestedStringByKeys(item, ["price"]), currency) ??
    priceFromUnknown(findNestedStringByKeys(item, ["old_price"]), currency);

  return {
    provider,
    productId,
    title,
    productUrl: formatProductUrl(productUrlTemplate, {
      sku,
      productId,
      offerId: findStringByKeys(item, ["offer_id", "offerId"]),
    }),
    imageUrl: images[0],
    images: images.length ? images : undefined,
    price,
    brand: findNestedStringByKeys(item, ["brand", "brand_name"]),
    category: findNestedStringByKeys(item, [
      "category_name",
      "category",
      "type_name",
      "description_category_id",
    ]),
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
