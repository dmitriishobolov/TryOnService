import { createHash, createHmac } from "node:crypto";

import type { MarketProductRef } from "../../../shared/contracts/index.js";
import type { AliExpressSignMethod } from "../../config/index.js";
import type { MarketplaceAdapter, MarketplaceSearchResult } from "../types.js";
import {
  collectNestedStringsByKeys,
  fetchMarketJson,
  findNestedStringByKeys,
  findStringByKeys,
  isRecord,
  limitProducts,
  priceFromUnknown,
  requireMarketCredential,
} from "../utils.js";

const provider = "aliexpress";
const method = "aliexpress.affiliate.product.query";

export const aliexpressMarketplaceAdapter: MarketplaceAdapter = {
  provider,
  displayName: "AliExpress",
  isConfigured: (config) =>
    Boolean(
      config.market.aliexpress.apiKey && config.market.aliexpress.apiSecret,
    ),
  search: async ({
    query,
    selection,
    config,
    signal,
  }): Promise<MarketplaceSearchResult> => {
    const marketConfig = config.market.aliexpress;
    const appKey = requireMarketCredential(
      provider,
      "ALIEXPRESS_APP_KEY",
      marketConfig.apiKey,
    );
    const appSecret = requireMarketCredential(
      provider,
      "ALIEXPRESS_APP_SECRET",
      marketConfig.apiSecret,
    );
    const limit = Math.min(selection.limit ?? config.market.searchLimit, 50);
    const params = removeEmptyParams({
      app_key: appKey,
      format: "json",
      method,
      partner_id: "tryonservice",
      sign_method: marketConfig.signMethod,
      timestamp: formatTopTimestamp(new Date()),
      v: "2.0",
      app_signature: marketConfig.appSignature,
      category_ids: selection.categoryIds?.join(","),
      fields: marketConfig.fields,
      keywords: query,
      max_sale_price: selection.maxPrice?.toString(),
      min_sale_price: selection.minPrice?.toString(),
      page_no: "1",
      page_size: String(limit),
      platform_product_type: marketConfig.platformProductType,
      ship_to_country: selection.country ?? marketConfig.shipToCountry,
      sort: selection.sort ?? marketConfig.sort,
      target_currency: selection.currency ?? marketConfig.targetCurrency,
      target_language: selection.locale ?? marketConfig.targetLanguage,
      tracking_id: marketConfig.trackingId,
      delivery_days: marketConfig.deliveryDays,
    });

    params.sign = signTopRequest(params, appSecret, marketConfig.signMethod);

    const response = await fetchMarketJson<unknown>(
      provider,
      marketConfig.baseUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: new URLSearchParams(params).toString(),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );

    return {
      provider,
      products: limitProducts(parseAliExpressProducts(response), limit),
    };
  },
};

function signTopRequest(
  params: Record<string, string>,
  appSecret: string,
  signMethod: AliExpressSignMethod,
): string {
  const payload = Object.keys(params)
    .filter((key) => key !== "sign" && params[key])
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  if (signMethod === "hmac") {
    return createHmac("md5", appSecret)
      .update(payload, "utf8")
      .digest("hex")
      .toUpperCase();
  }

  if (signMethod === "hmac-sha256") {
    return createHmac("sha256", appSecret)
      .update(payload, "utf8")
      .digest("hex")
      .toUpperCase();
  }

  return createHash("md5")
    .update(`${appSecret}${payload}${appSecret}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

function parseAliExpressProducts(response: unknown): MarketProductRef[] {
  const products = findAliExpressProductsArray(response);

  return products
    .map(normalizeAliExpressProduct)
    .filter((product): product is MarketProductRef => Boolean(product));
}

function findAliExpressProductsArray(response: unknown): unknown[] {
  const candidate =
    findNestedArrayByKeys(response, ["product"]) ??
    findNestedArrayByKeys(response, ["products"]) ??
    [];

  return candidate;
}

function normalizeAliExpressProduct(value: unknown): MarketProductRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const productId = findStringByKeys(value, [
    "product_id",
    "productId",
    "item_id",
    "itemId",
  ]);
  const title = findStringByKeys(value, [
    "product_title",
    "productTitle",
    "title",
    "subject",
  ]);

  if (!productId || !title) {
    return undefined;
  }

  const images = collectNestedStringsByKeys(value, [
    "product_main_image_url",
    "productMainImageUrl",
    "image_url",
    "imageUrl",
    "url",
    "string",
  ]).filter(isHttpUrl);
  const currency = findStringByKeys(value, [
    "target_sale_price_currency",
    "sale_price_currency",
    "currency",
  ]);
  const price =
    priceFromUnknown(value.target_app_sale_price, currency) ??
    priceFromUnknown(value.app_sale_price, currency) ??
    priceFromUnknown(value.target_sale_price, currency) ??
    priceFromUnknown(value.sale_price, currency);

  return {
    provider,
    productId,
    title,
    productUrl: findStringByKeys(value, [
      "product_detail_url",
      "productDetailUrl",
      "product_url",
      "url",
    ]),
    imageUrl: images[0],
    images: images.length ? images : undefined,
    price,
    category:
      findStringByKeys(value, ["second_level_category_name"]) ??
      findStringByKeys(value, ["first_level_category_name"]),
  };
}

function findNestedArrayByKeys(
  value: unknown,
  keys: string[],
): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const current = value[key];

    if (Array.isArray(current)) {
      return current;
    }

    if (isRecord(current)) {
      const nested = findNestedArrayByKeys(current, keys);

      if (nested) {
        return nested;
      }
    }
  }

  for (const current of Object.values(value)) {
    const nested = findNestedArrayByKeys(current, keys);

    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function removeEmptyParams(
  params: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

function formatTopTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds(),
  )}`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

