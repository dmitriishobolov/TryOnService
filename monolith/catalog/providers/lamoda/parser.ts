import { chromium, type BrowserContext, type Page, type Response } from "playwright";

import type { MonolithConfig } from "../../../config.js";
import type { GarmentCatalogItem, GarmentGender } from "../../../types.js";
import { sleep } from "../../../utils/http.js";
import { createLogger } from "../../../utils/logger.js";
import { createLamodaBrowserLaunchOptions } from "./browser.js";

const logger = createLogger("monolith");
const LAMODA_BASE_URL = "https://www.lamoda.ru";
const LAMODA_SKU_PATTERN = "\\b([a-zA-Z]{2}[a-zA-Z0-9]{6,18})\\b";
const PRICE_TEXT_RE = /\u20bd|\u0440\u0443\u0431/i;

const RU = {
  lamoda: "\u043b\u0430\u043c\u043e\u0434\u0430",
  male: "\u041c\u0443\u0436\u0441\u043a\u043e\u0435",
  female: "\u0416\u0435\u043d\u0441\u043a\u043e\u0435",
  unisex: "\u0423\u043d\u0438\u0441\u0435\u043a\u0441",
  color: "\u0446\u0432\u0435\u0442",
  sizes: "\u0440\u0430\u0437\u043c\u0435\u0440\u044b",
  other: "\u0434\u0440\u0443\u0433\u043e\u0435",
  categories: {
    tuxedo: "\u0441\u043c\u043e\u043a\u0438\u043d\u0433",
    suit: "\u043a\u043e\u0441\u0442\u044e\u043c",
    blazer: "\u043f\u0438\u0434\u0436\u0430\u043a",
    anorak: "\u0430\u043d\u043e\u0440\u0430\u043a",
    shearling: "\u0434\u0443\u0431\u043b\u0435\u043d\u043a\u0430",
    jacket: "\u043a\u0443\u0440\u0442\u043a\u0430",
    coat: "\u043f\u0430\u043b\u044c\u0442\u043e",
    trench: "\u043f\u043b\u0430\u0449",
    jumpsuit: "\u043a\u043e\u043c\u0431\u0438\u043d\u0435\u0437\u043e\u043d",
    shirt: "\u0440\u0443\u0431\u0430\u0448\u043a\u0430",
    pants: "\u0431\u0440\u044e\u043a\u0438",
    longsleeve: "\u043b\u043e\u043d\u0433\u0441\u043b\u0438\u0432",
    tshirt: "\u0444\u0443\u0442\u0431\u043e\u043b\u043a\u0430",
    jeans: "\u0434\u0436\u0438\u043d\u0441\u044b",
    hoodie: "\u0445\u0443\u0434\u0438",
    sweater: "\u0441\u0432\u0438\u0442\u0435\u0440",
    cardigan: "\u043a\u0430\u0440\u0434\u0438\u0433\u0430\u043d",
    vest: "\u0436\u0438\u043b\u0435\u0442",
    polo: "\u043f\u043e\u043b\u043e",
    tank: "\u043c\u0430\u0439\u043a\u0430",
    top: "\u0442\u043e\u043f",
    shorts: "\u0448\u043e\u0440\u0442\u044b",
    skirt: "\u044e\u0431\u043a\u0430",
    dress: "\u043f\u043b\u0430\u0442\u044c\u0435",
    socks: "\u043d\u043e\u0441\u043a\u0438",
    underwear: "\u043d\u0438\u0436\u043d\u0435\u0435 \u0431\u0435\u043b\u044c\u0435",
    pyjama: "\u043f\u0438\u0436\u0430\u043c\u0430",
    robe: "\u0445\u0430\u043b\u0430\u0442",
    swimwear: "\u043f\u043b\u0430\u0432\u043a\u0438",
    shoes: "\u043e\u0431\u0443\u0432\u044c",
  },
  colors: {
    white: "\u0431\u0435\u043b\u044b\u0439",
    black: "\u0447\u0435\u0440\u043d\u044b\u0439",
    gray: "\u0441\u0435\u0440\u044b\u0439",
    blue: "\u0441\u0438\u043d\u0438\u0439",
    lightBlue: "\u0433\u043e\u043b\u0443\u0431\u043e\u0439",
    beige: "\u0431\u0435\u0436\u0435\u0432\u044b\u0439",
    brown: "\u043a\u043e\u0440\u0438\u0447\u043d\u0435\u0432\u044b\u0439",
    green: "\u0437\u0435\u043b\u0435\u043d\u044b\u0439",
    olive: "\u043e\u043b\u0438\u0432\u043a\u043e\u0432\u044b\u0439",
    red: "\u043a\u0440\u0430\u0441\u043d\u044b\u0439",
    burgundy: "\u0431\u043e\u0440\u0434\u043e\u0432\u044b\u0439",
    pink: "\u0440\u043e\u0437\u043e\u0432\u044b\u0439",
    yellow: "\u0436\u0435\u043b\u0442\u044b\u0439",
    orange: "\u043e\u0440\u0430\u043d\u0436\u0435\u0432\u044b\u0439",
    purple: "\u0444\u0438\u043e\u043b\u0435\u0442\u043e\u0432\u044b\u0439",
  },
} as const;

export interface LamodaCatalogParseOptions {
  gender?: GarmentGender;
}

export interface LamodaCatalogWalkOptions extends LamodaCatalogParseOptions {
  startPage?: number;
  stopOnPageError?: boolean;
  onPage?: (batch: LamodaCatalogPageBatch) => Promise<void> | void;
}

export interface LamodaCatalogPageBatch {
  sourceUrl: string;
  pageUrl: string;
  pageNumber: number;
  pageLimit: number;
  discoveredPages: number;
  status?: number;
  items: GarmentCatalogItem[];
}

interface LamodaCatalogPage {
  url: string;
  title: string;
  status?: number;
  products: LamodaTileProduct[];
  pageCount?: number;
}

interface LamodaTileProduct {
  sku: string;
  title?: string;
  brand?: string;
  productUrl: string;
  imageUrl?: string;
  price?: GarmentCatalogItem["price"];
}

interface LamodaExtractedPage {
  title: string;
  url: string;
  pageCount?: number;
  bodyPreview?: string;
  linkCount?: number;
  productHrefSamples?: string[];
  products: Array<{
    sku: string;
    title?: string;
    brand?: string;
    productUrl: string;
    imageUrl?: string;
    priceText?: string;
    oldPriceText?: string;
  }>;
}

interface LamodaProductPageDetails {
  title?: string;
  brand?: string;
  sizes: string[];
  colors: string[];
  price?: GarmentCatalogItem["price"];
  imageUrl?: string;
  tags: string[];
  status?: number;
}

interface LamodaExtractedProductPage {
  title: string;
  url: string;
  bodyPreview?: string;
  titleText?: string;
  brand?: string;
  imageUrl?: string;
  priceText?: string;
  oldPriceText?: string;
  sizes: string[];
  colors: string[];
  tags: string[];
}

interface LamodaBrowserSession {
  context: BrowserContext;
  page: Page;
}

const LAMODA_SCROLL_SCRIPT = [
  "return new Promise((resolve) => {",
  "  const height = Math.max(",
  "    Number((document.body && document.body.scrollHeight) || 0),",
  "    Number((document.documentElement && document.documentElement.scrollHeight) || 0),",
  "  );",
  "  let y = 0;",
  "  function step() {",
  "    if (y > height) {",
  "      scrollTo(0, 0);",
  "      setTimeout(resolve, 500);",
  "      return;",
  "    }",
  "    scrollTo(0, y);",
  "    y += 900;",
  "    setTimeout(step, 80);",
  "  }",
  "  step();",
  "})",
].join("\n");

const LAMODA_EXTRACT_SCRIPT = [
  "const skuRe = new RegExp(skuPattern, 'i');",
  "const productPathRe = /\\/p\\/[a-zA-Z]{2}[a-zA-Z0-9]{6,18}/i;",
  "const badgeRe = /^-?\\d+\\s*%$/;",
  "const products = [];",
  "const seen = new Set();",
  "const allAnchors = Array.from(document.getElementsByTagName('a'));",
  "function cleanText(value) {",
  "  const normalized = typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '';",
  "  return normalized || undefined;",
  "}",
  "function textOf(node) {",
  "  return cleanText(node && node.textContent);",
  "}",
  "function all(root, selector) {",
  "  return Array.from((root && root.querySelectorAll && root.querySelectorAll(selector)) || []);",
  "}",
  "function readImage(root, anchor) {",
  "  const image = (root && root.querySelector && root.querySelector('img')) ||",
  "    (anchor && anchor.querySelector && anchor.querySelector('img'));",
  "  const srcset = image && (image.getAttribute('srcset') || image.getAttribute('data-srcset'));",
  "  const srcsetUrl = srcset",
  "    ? srcset.split(',').map((item) => item.trim().split(/\\s+/)[0]).filter(Boolean).at(-1)",
  "    : undefined;",
  "  return (image && image.currentSrc) ||",
  "    (image && image.getAttribute('src')) ||",
  "    (image && image.getAttribute('data-src')) ||",
  "    srcsetUrl ||",
  "    undefined;",
  "}",
  "function findTileRoot(anchor) {",
  "  let current = anchor;",
  "  for (let depth = 0; current && current.parentElement && depth < 8; depth += 1) {",
  "    const parent = current.parentElement;",
  "    const productLinks = all(parent, 'a').filter((item) => productPathRe.test(String(item.href || '')));",
  "    if (productLinks.length > 1) {",
  "      return current;",
  "    }",
  "    current = parent;",
  "  }",
  "  return (anchor && anchor.closest && anchor.closest(\"article, li, [data-testid], [class*='product'], [class*='card']\")) || anchor;",
  "}",
  "function findTitle(root, anchor) {",
  "  const selectors = [\"[class*='product-name']\", \"[class*='name']\", \"[class*='title']\", \"[class*='brand']\"];",
  "  for (const selector of selectors) {",
  "    for (const node of all(root, selector)) {",
  "      const value = textOf(node);",
  "      if (value && !badgeRe.test(value)) {",
  "        return value;",
  "      }",
  "    }",
  "  }",
  "  const titleAttr = cleanText(anchor && anchor.getAttribute && anchor.getAttribute('title'));",
  "  const anchorText = textOf(anchor);",
  "  return titleAttr || (anchorText && !badgeRe.test(anchorText) ? anchorText : undefined);",
  "}",
  "function readPriceTexts(root) {",
  "  const priceRoot = (root && root.querySelector && root.querySelector(\"[class*='price-wrap'], [class*='price']\")) || root;",
  "  const values = all(priceRoot, '*')",
  "    .concat([priceRoot])",
  "    .map((node) => textOf(node))",
  "    .filter((value) => Boolean(value && /\\u20bd|\\u0440\\u0443\\u0431/i.test(value)))",
  "    .filter((value) => value.length <= 80);",
  "  return Array.from(new Set(values));",
  "}",
  "const pageCount = Math.max(",
  "  0,",
  "  ...all(document, \"a[href*='page='], a[href*='?page']\")",
  "    .map((anchor) => {",
  "      try {",
  "        return Number(new URL(String(anchor.href || '')).searchParams.get('page') || '0');",
  "      } catch {",
  "        return 0;",
  "      }",
  "    })",
  "    .filter((value) => Number.isFinite(value)),",
  ");",
  "for (const anchor of allAnchors) {",
  "  const href = String(anchor.href || '');",
  "  const match = href.match(skuRe);",
  "  if (!match || !productPathRe.test(href)) {",
  "    continue;",
  "  }",
  "  const sku = match[1].toUpperCase();",
  "  if (seen.has(sku)) {",
  "    continue;",
  "  }",
  "  seen.add(sku);",
  "  const root = findTileRoot(anchor);",
  "  const title = findTitle(root, anchor);",
  "  const lines = String((root && root.textContent) || '')",
  "    .split('\\n')",
  "    .map((line) => cleanText(line))",
  "    .filter((line) => Boolean(line && !badgeRe.test(line)));",
  "  const priceTexts = readPriceTexts(root);",
  "  products.push({",
  "    sku,",
  "    title,",
  "    brand: lines.find((line) => line !== title && !/\\u20bd|\\u0440\\u0443\\u0431/i.test(line)),",
  "    productUrl: href,",
  "    imageUrl: readImage(root, anchor),",
  "    priceText: priceTexts[0],",
  "    oldPriceText: priceTexts[1],",
  "  });",
  "}",
  "return {",
  "  title: document.title,",
  "  url: location.href,",
  "  pageCount: pageCount || undefined,",
  "  products,",
  "};",
].join("\n");

const LAMODA_PRODUCT_EXTRACT_SCRIPT = [
  "function cleanText(value) {",
  "  const normalized = typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '';",
  "  return normalized || undefined;",
  "}",
  "function all(root, selector) {",
  "  return Array.from((root && root.querySelectorAll && root.querySelectorAll(selector)) || []);",
  "}",
  "function unique(values) {",
  "  return Array.from(new Set(values.map((value) => cleanText(value)).filter(Boolean)));",
  "}",
  "function textOf(node) {",
  "  return cleanText(node && node.textContent);",
  "}",
  "function flatten(value) {",
  "  if (Array.isArray(value)) {",
  "    return value.flatMap((item) => flatten(item));",
  "  }",
  "  if (value && typeof value === 'object') {",
  "    return Object.values(value).flatMap((item) => flatten(item));",
  "  }",
  "  return typeof value === 'string' ? [value] : [];",
  "}",
  "function readJsonLdProducts() {",
  "  const products = [];",
  "  function visit(value) {",
  "    if (!value) {",
  "      return;",
  "    }",
  "    if (Array.isArray(value)) {",
  "      value.forEach(visit);",
  "      return;",
  "    }",
  "    if (typeof value !== 'object') {",
  "      return;",
  "    }",
  "    const type = String(value['@type'] || value.type || '').toLowerCase();",
  "    if (type.includes('product')) {",
  "      products.push(value);",
  "    }",
  "    Object.values(value).forEach(visit);",
  "  }",
  "  for (const node of all(document, 'script[type=\\\"application/ld+json\\\"]')) {",
  "    try {",
  "      visit(JSON.parse(node.textContent || 'null'));",
  "    } catch {",
  "      // Ignore malformed JSON-LD blocks.",
  "    }",
  "  }",
  "  return products;",
  "}",
  "const jsonProducts = readJsonLdProducts();",
  "const jsonProduct = jsonProducts[0] || {};",
  "function firstString(values) {",
  "  return flatten(values).map((item) => cleanText(item)).find(Boolean);",
  "}",
  "function readMeta(selector) {",
  "  const node = document.querySelector(selector);",
  "  return cleanText(node && node.getAttribute('content'));",
  "}",
  "function readTitle() {",
  "  return cleanText(jsonProduct.name) ||",
  "    readMeta('meta[property=\\\"og:title\\\"]') ||",
  "    textOf(document.querySelector('h1')) ||",
  "    cleanText(document.title);",
  "}",
  "function readBrand() {",
  "  const rawBrand = jsonProduct.brand;",
  "  if (typeof rawBrand === 'string') {",
  "    return cleanText(rawBrand);",
  "  }",
  "  if (rawBrand && typeof rawBrand === 'object') {",
  "    return cleanText(rawBrand.name);",
  "  }",
  "  const candidate = all(document, '[class*=\\\"brand\\\"], [data-testid*=\\\"brand\\\"]')",
  "    .map((node) => textOf(node))",
  "    .find((value) => Boolean(value && value.length <= 80));",
  "  return candidate;",
  "}",
  "function imageFromSrcset(srcset) {",
  "  return cleanText(srcset)",
  "    ? srcset.split(',').map((item) => item.trim().split(/\\s+/)[0]).filter(Boolean).at(-1)",
  "    : undefined;",
  "}",
  "function readImages() {",
  "  const values = [];",
  "  values.push(...flatten(jsonProduct.image));",
  "  values.push(readMeta('meta[property=\\\"og:image\\\"]'));",
  "  for (const image of all(document, 'img')) {",
  "    values.push(image.currentSrc);",
  "    values.push(image.getAttribute('src'));",
  "    values.push(image.getAttribute('data-src'));",
  "    values.push(imageFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset')));",
  "  }",
  "  return unique(values).filter((value) => /\\.(jpg|jpeg|png|webp)(\\?|$)|image|static|cdn/i.test(value));",
  "}",
  "function readOfferValues(field) {",
  "  const offers = jsonProduct.offers;",
  "  if (Array.isArray(offers)) {",
  "    return offers.map((offer) => offer && typeof offer === 'object' ? offer[field] : undefined);",
  "  }",
  "  if (offers && typeof offers === 'object') {",
  "    return [offers[field]];",
  "  }",
  "  return [];",
  "}",
  "function readPriceTexts() {",
  "  const values = [];",
  "  values.push(...readOfferValues('price'));",
  "  values.push(...readOfferValues('lowPrice'));",
  "  values.push(...readOfferValues('highPrice'));",
  "  values.push(...all(document, '[class*=\\\"price\\\"], [data-testid*=\\\"price\\\"]')",
  "    .map((node) => textOf(node))",
  "    .filter((value) => Boolean(value && value.length <= 80)));",
  "  return unique(values).filter((value) => /\\d/.test(value));",
  "}",
  "function isUnavailable(node) {",
  "  const disabledAttr = Boolean(node && node.hasAttribute && node.hasAttribute('disabled'));",
  "  const ariaDisabled = String((node && node.getAttribute && node.getAttribute('aria-disabled')) || '').toLowerCase();",
  "  const rawClass = String((node && node.className) || '');",
  "  return disabledAttr || ariaDisabled === 'true' || /unavailable|sold|out-of-stock|not_available|\\bdisabled\\b/i.test(rawClass);",
  "}",
  "function normalizeSize(value) {",
  "  const text = cleanText(String(value || '').replace(/^.*?:/i, '').replace(/\\b(RU|EU|US|UK)\\b/gi, ''));",
  "  if (!text || text.length > 18) {",
  "    return undefined;",
  "  }",
  "  if (/^(one size|os|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|[0-9]{1,3}(?:[,.][0-9])?|[0-9]{1,3}\\s*-\\s*[0-9]{1,3}|[a-z]{1,4}\\s*\\/\\s*[a-z]{1,4})$/i.test(text)) {",
  "    return text.replace(/\\s+/g, '').toUpperCase();",
  "  }",
  "  return undefined;",
  "}",
  "function readSizes() {",
  "  const values = [];",
  "  values.push(...readOfferValues('size'));",
  "  values.push(...readOfferValues('name'));",
  "  const selectors = [",
  "    'button',",
  "    '[role=\\\"button\\\"]',",
  "    '[class*=\\\"size\\\"]',",
  "    '[data-testid*=\\\"size\\\"]',",
  "    '[aria-label*=\\\"size\\\" i]',",
  "    '[aria-label*=\\\"\\u0440\\u0430\\u0437\\u043c\\u0435\\u0440\\\" i]'",
  "  ].join(',');",
  "  for (const node of all(document, selectors)) {",
  "    if (isUnavailable(node)) {",
  "      continue;",
  "    }",
  "    values.push(textOf(node));",
  "    values.push(node.getAttribute && node.getAttribute('title'));",
  "    values.push(node.getAttribute && node.getAttribute('aria-label'));",
  "  }",
  "  return unique(values.map((value) => normalizeSize(value))).slice(0, 30);",
  "}",
  "function readColors() {",
  "  const values = [];",
  "  values.push(jsonProduct.color);",
  "  values.push(readMeta('meta[itemprop=\\\"color\\\"]'));",
  "  const bodyText = String((document.body && document.body.innerText) || '');",
  "  const colorMatch = bodyText.match(/(?:\\u0426\\u0432\\u0435\\u0442|Color)\\s*:?\\s*([^\\n]+)/i);",
  "  if (colorMatch) {",
  "    values.push(colorMatch[1]);",
  "  }",
  "  const selectors = [",
  "    '[itemprop=\\\"color\\\"]',",
  "    '[class*=\\\"color\\\"]',",
  "    '[data-testid*=\\\"color\\\"]',",
  "    '[aria-label*=\\\"color\\\" i]',",
  "    '[aria-label*=\\\"\\u0446\\u0432\\u0435\\u0442\\\" i]'",
  "  ].join(',');",
  "  for (const node of all(document, selectors)) {",
  "    values.push(textOf(node));",
  "    values.push(node.getAttribute && node.getAttribute('title'));",
  "    values.push(node.getAttribute && node.getAttribute('aria-label'));",
  "    values.push(node.getAttribute && node.getAttribute('data-color'));",
  "  }",
  "  return unique(values).filter((value) => value.length <= 80).slice(0, 20);",
  "}",
  "const priceTexts = readPriceTexts();",
  "const sizes = readSizes();",
  "const colors = readColors();",
  "const titleText = readTitle();",
  "const brand = readBrand();",
  "return {",
  "  title: document.title,",
  "  url: location.href,",
  "  bodyPreview: cleanText(String((document.body && document.body.innerText) || '').slice(0, 500)),",
  "  titleText,",
  "  brand,",
  "  imageUrl: readImages()[0],",
  "  priceText: priceTexts[0],",
  "  oldPriceText: priceTexts[1],",
  "  sizes,",
  "  colors,",
  "  tags: unique([titleText, brand, ...sizes, ...colors]),",
  "};",
].join("\\n");


export async function parseLamodaCatalogUrl(
  url: string,
  config: MonolithConfig,
  options: LamodaCatalogParseOptions = {},
): Promise<GarmentCatalogItem[]> {
  return walkLamodaCatalogUrl(url, config, options);
}

export async function walkLamodaCatalogUrl(
  url: string,
  config: MonolithConfig,
  options: LamodaCatalogWalkOptions = {},
): Promise<GarmentCatalogItem[]> {
  const gender = options.gender ?? "unisex";
  const startPage = Math.max(1, Math.floor(options.startPage ?? 1));

  logger.info("Monolith Lamoda catalog read started", {
    url,
    gender,
    startPage,
  });

  const context = await createLamodaBrowserContext(config);
  const session: LamodaBrowserSession = {
    context,
    page: await createLamodaPage(context),
  };

  try {
    await prepareLamodaSession(session, config);

    const byId = new Map<string, GarmentCatalogItem>();
    const firstPage = await readLamodaCatalogPageWithRetries(session, pageUrlFor(url, 1), config, 1);
    const discoveredPages = Math.max(1, firstPage.pageCount ?? 1);
    const pageLimit = config.catalog.lamodaMaxPages > 0
      ? Math.min(discoveredPages, config.catalog.lamodaMaxPages)
      : discoveredPages;
    const itemLimit = config.catalog.batchSize;
    let emittedItems = 0;

    logger.info("Monolith Lamoda catalog first page parsed", {
      url,
      title: firstPage.title,
      status: firstPage.status,
      gender,
      discoveredPages,
      pageLimit,
      products: firstPage.products.length,
    });

    const emitPage = async (
      catalogPage: LamodaCatalogPage,
      pageNumber: number,
    ): Promise<void> => {
      const normalized = await normalizeLamodaProducts(context, catalogPage.products, catalogPage.url, gender, config);
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
          status: catalogPage.status,
          items,
        });
      }
    };

    if (startPage <= 1) {
      await emitPage(firstPage, 1);
    }

    if (startPage > pageLimit) {
      logger.info("Monolith Lamoda catalog source already completed by checkpoint", {
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

      if (config.catalog.lamodaPageDelayMs > 0) {
        await sleep(config.catalog.lamodaPageDelayMs);
      }

      const currentUrl = pageUrlFor(url, pageNumber);

      try {
        const currentPage = await readLamodaCatalogPageWithRetries(session, currentUrl, config, pageNumber);
        await emitPage(currentPage, pageNumber);

        if (
          pageNumber % config.catalog.lamodaProgressLogEveryPages === 0 ||
          pageNumber === pageLimit
        ) {
          logger.info("Monolith Lamoda catalog parse progress", {
            url,
            gender,
            page: pageNumber,
            pageLimit,
            items: byId.size,
          });
        }
      } catch (error) {
        logger.warn("Monolith Lamoda catalog page parse failed", {
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

    logger.info("Monolith Lamoda catalog parsed", {
      url,
      gender,
      discoveredPages,
      pageLimit,
      items: items.length,
    });

    return items;
  } finally {
    await context.close();
  }
}

async function createLamodaBrowserContext(config: MonolithConfig): Promise<BrowserContext> {
  return chromium.launchPersistentContext(config.catalog.lamodaUserDataDir, {
    ...createLamodaBrowserLaunchOptions(config),
    headless: config.catalog.browserHeadless,
    userAgent: config.catalog.userAgent,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1366, height: 900 },
    colorScheme: "light",
    extraHTTPHeaders: {
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.6,en;q=0.4",
    },
  });
}

async function createLamodaPage(context: BrowserContext): Promise<Page> {
  return context.newPage();
}

async function ensureLamodaPage(session: LamodaBrowserSession): Promise<Page> {
  if (session.page.isClosed()) {
    session.page = await createLamodaPage(session.context);
  }

  return session.page;
}

async function prepareLamodaSession(
  session: LamodaBrowserSession,
  config: MonolithConfig,
): Promise<void> {
  const page = await ensureLamodaPage(session);

  try {
    await page.goto(LAMODA_BASE_URL, {
      waitUntil: config.catalog.browserWaitUntil,
      timeout: config.catalog.browserTimeoutMs,
    });
    await humanPause(page, 800, 1_800);
    await acceptLamodaCookieBanner(page);
    await humanScroll(page);
  } catch (error) {
    logger.debug("Monolith Lamoda session warmup skipped", {
      error: errorMessage(error),
    });
  }
}

async function readLamodaCatalogPageWithRetries(
  session: LamodaBrowserSession,
  url: string,
  config: MonolithConfig,
  pageNumber: number,
): Promise<LamodaCatalogPage> {
  const attempts = Math.max(1, config.catalog.lamodaPageRetryAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const page = await ensureLamodaPage(session);

    try {
      const result = await readLamodaCatalogPage(page, url, config, pageNumber > 1);

      if (result.products.length > 0) {
        return result;
      }

      lastError = new Error("Lamoda page " + pageNumber + " returned no products");
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      const delayMs = config.catalog.lamodaRetryDelayMs * attempt;

      logger.warn("Monolith Lamoda catalog page retry scheduled", {
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
    : new Error("Lamoda page " + pageNumber + " parse failed");
}

async function readLamodaCatalogPage(
  page: Page,
  url: string,
  config: MonolithConfig,
  preferLinkNavigation: boolean,
): Promise<LamodaCatalogPage> {
  const response = await navigateLamodaCatalogPage(page, url, config, preferLinkNavigation);

  await humanPause(page, 900, 1_900);
  await acceptLamodaCookieBanner(page);
  await warmUpLamodaLazyImages(page);

  let status = response?.status();
  let extracted = await extractLamodaPage(page);

  if (!status && isLamodaRejectedPage(extracted.title, extracted.bodyPreview)) {
    status = 403;
  }

  if (extracted.products.length === 0 && status === 403 && config.catalog.lamodaSecurityWaitMs > 0) {
    logger.warn("Monolith Lamoda security page detected; waiting before reload", {
      pageUrl: extracted.url,
      waitMs: config.catalog.lamodaSecurityWaitMs,
    });
    await page.waitForTimeout(config.catalog.lamodaSecurityWaitMs);
    const reloadResponse = await page.reload({
      waitUntil: config.catalog.browserWaitUntil,
      timeout: config.catalog.browserTimeoutMs,
    });
    status = reloadResponse?.status() ?? status;
    await humanPause(page, 900, 1_900);
    await acceptLamodaCookieBanner(page);
    await warmUpLamodaLazyImages(page);
    extracted = await extractLamodaPage(page);

    if (!status && isLamodaRejectedPage(extracted.title, extracted.bodyPreview)) {
      status = 403;
    }
  }

  if (extracted.products.length === 0) {
    logger.warn("Monolith Lamoda page returned no product anchors", {
      pageUrl: extracted.url,
      status,
      title: extracted.title,
      bodyPreview: extracted.bodyPreview,
      linkCount: extracted.linkCount,
      productHrefSamples: extracted.productHrefSamples,
    });
  }

  return {
    url: extracted.url,
    title: extracted.title,
    status,
    products: extracted.products
      .map((product) => ({
        ...product,
        productUrl: absolutizeLamodaUrl(product.productUrl, extracted.url),
        imageUrl: product.imageUrl ? absolutizeLamodaUrl(product.imageUrl, extracted.url) : undefined,
        price: priceFromTexts(product.priceText, product.oldPriceText),
      })),
    pageCount: extracted.pageCount,
  };
}

async function extractLamodaPage(page: Page): Promise<LamodaExtractedPage> {
  return page.evaluate(
    new Function("skuPattern", LAMODA_EXTRACT_SCRIPT) as any,
    LAMODA_SKU_PATTERN,
  ) as Promise<LamodaExtractedPage>;
}

async function warmUpLamodaLazyImages(page: Page): Promise<void> {
  await page.evaluate(new Function(LAMODA_SCROLL_SCRIPT) as any);
}

async function navigateLamodaCatalogPage(
  page: Page,
  url: string,
  config: MonolithConfig,
  preferLinkNavigation: boolean,
): Promise<Response | null> {
  if (preferLinkNavigation && await clickLamodaPageLink(page, url, config)) {
    return null;
  }

  return page.goto(url, {
    waitUntil: config.catalog.browserWaitUntil,
    timeout: config.catalog.browserTimeoutMs,
  });
}

async function clickLamodaPageLink(
  page: Page,
  targetUrl: string,
  config: MonolithConfig,
): Promise<boolean> {
  const script = [
    "const target = new URL(value);",
    "const targetPage = target.searchParams.get('page') || '1';",
    "const anchors = Array.from(document.getElementsByTagName('a'));",
    "const anchor = anchors.find((item) => {",
    "  try {",
    "    const current = new URL(String(item.href || ''));",
    "    return current.hostname === target.hostname &&",
    "      current.pathname === target.pathname &&",
    "      (current.searchParams.get('page') || '1') === targetPage;",
    "  } catch {",
    "    return false;",
    "  }",
    "});",
    "return anchor || null;",
  ].join("\n");
  const handle = await page.evaluateHandle(
    new Function("value", script) as any,
    targetUrl,
  );
  const element = handle.asElement();

  if (!element) {
    await handle.dispose();
    return false;
  }

  try {
    await element.scrollIntoViewIfNeeded();
    await humanPause(page, 250, 800);
    await Promise.all([
      page.waitForLoadState(config.catalog.browserWaitUntil, {
        timeout: config.catalog.browserTimeoutMs,
      }).catch(() => undefined),
      element.click({ delay: randomInt(40, 160), timeout: 5_000 }),
    ]);
    await handle.dispose();
    return sameLamodaCatalogPage(page.url(), targetUrl);
  } catch (error) {
    await handle.dispose();
    logger.debug("Monolith Lamoda link navigation fallback to goto", {
      targetUrl,
      error: errorMessage(error),
    });
    return false;
  }
}

async function acceptLamodaCookieBanner(page: Page): Promise<void> {
  const script = [
    "const patterns = [",
    "  /\\u043f\\u0440\\u0438\\u043d\\u044f\\u0442/i,",
    "  /\\u0441\\u043e\\u0433\\u043b\\u0430\\u0441/i,",
    "  /ok/i,",
    "  /accept/i,",
    "];",
    "const buttons = Array.from(document.querySelectorAll('button, [role=button]'));",
    "const button = buttons.find((item) => {",
    "  const text = String(item.textContent || '').replace(/\\s+/g, ' ').trim();",
    "  return text.length <= 80 && patterns.some((pattern) => pattern.test(text));",
    "});",
    "if (button && typeof button.click === 'function') {",
    "  button.click();",
    "  return true;",
    "}",
    "return false;",
  ].join("\n");
  const clicked = await page.evaluate(
    new Function(script) as any,
  ).catch(() => false);

  if (clicked) {
    await humanPause(page, 300, 900);
  }
}

async function humanScroll(page: Page): Promise<void> {
  await page.mouse.move(randomInt(200, 700), randomInt(180, 500));
  await page.mouse.wheel(0, randomInt(350, 900));
  await humanPause(page, 250, 700);
  await page.mouse.wheel(0, -randomInt(120, 420));
  await humanPause(page, 250, 700);
}

async function humanPause(page: Page, minMs: number, maxMs: number): Promise<void> {
  await page.waitForTimeout(randomInt(minMs, maxMs));
}

function sameLamodaCatalogPage(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);

    return current.hostname === target.hostname &&
      current.pathname === target.pathname &&
      (current.searchParams.get("page") || "1") === (target.searchParams.get("page") || "1");
  } catch {
    return false;
  }
}

function isLamodaRejectedPage(title: string | undefined, bodyPreview: string | undefined): boolean {
  return /\u0417\u0430\u043f\u0440\u043e\u0441\s+\u043e\u0442\u043a\u043b\u043e\u043d\u0435\u043d|forbidden|access denied/i.test(
    [title, bodyPreview].filter(Boolean).join(" "),
  );
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);

  return Math.floor(Math.random() * (high - low + 1)) + low;
}

async function normalizeLamodaProducts(
  context: BrowserContext,
  products: LamodaTileProduct[],
  pageUrl: string,
  gender: GarmentGender,
  config: MonolithConfig,
): Promise<GarmentCatalogItem[]> {
  const productPages = await enrichLamodaProductPages(context, products, config);
  const now = new Date().toISOString();

  return products.flatMap((product) => {
    const pageDetails = productPages.get(product.sku);
    const title = pageDetails?.title || product.title;
    const brandName = pageDetails?.brand || product.brand;
    const price = pageDetails?.price ?? product.price;
    const sizes = uniqueStrings(pageDetails?.sizes ?? []);
    const colors = uniqueStrings([
      ...(pageDetails?.colors ?? []),
      ...readLamodaColors([title, product.productUrl, ...(pageDetails?.tags ?? [])]),
    ]);
    const imageUrl = pageDetails?.imageUrl || product.imageUrl || "";

    if (!product.sku || !title || !product.productUrl) {
      logger.debug("Monolith Lamoda product skipped because required table fields are missing", {
        sku: product.sku,
        title,
        productUrl: product.productUrl,
        hasImage: Boolean(imageUrl),
      });
      return [];
    }

    const category = inferCategory([
      product.productUrl,
      title,
      brandName,
    ].filter(Boolean).join(" "));
    const description = buildLamodaDescription({
      title,
      brandName,
      category,
      colors,
      sizes,
      price,
    });

    return [{
      id: "lamoda:" + product.sku,
      category,
      gender,
      title,
      description,
      sizes,
      colors,
      price,
      tags: uniqueStrings([
        "lamoda",
        RU.lamoda,
        gender,
        labelForGender(gender),
        brandName,
        title,
        category,
        ...sizes,
        ...colors,
      ].filter((item): item is string => Boolean(item && isUsefulSearchTag(item)))),
      productUrl: product.productUrl || new URL("/p/" + product.sku.toLowerCase() + "/", pageUrl).toString(),
      imageUrl,
      createdAt: now,
      updatedAt: now,
    }];
  });
}

async function enrichLamodaProductPages(
  context: BrowserContext,
  products: LamodaTileProduct[],
  config: MonolithConfig,
): Promise<Map<string, LamodaProductPageDetails>> {
  const mode = config.catalog.lamodaProductEnrichment;

  if (mode === "off" || products.length === 0) {
    return new Map();
  }

  const targets = products.filter((product) => shouldReadLamodaProductPage(product, mode));

  if (targets.length === 0) {
    return new Map();
  }

  logger.info("Monolith Lamoda product page enrichment started", {
    mode,
    products: products.length,
    targets: targets.length,
    concurrency: config.catalog.lamodaProductConcurrency,
    delayMs: config.catalog.lamodaProductPageDelayMs,
  });

  const details = new Map<string, LamodaProductPageDetails>();
  const concurrency = Math.max(1, Math.min(config.catalog.lamodaProductConcurrency, targets.length));
  let cursor = 0;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < targets.length) {
      const target = targets[cursor];
      cursor += 1;

      if (!target) {
        continue;
      }

      const result = await readLamodaProductPageWithRetries(context, target, config);

      if (result) {
        details.set(target.sku, result);
      }

      if (config.catalog.lamodaProductPageDelayMs > 0) {
        await sleep(config.catalog.lamodaProductPageDelayMs);
      }
    }
  }));

  logger.info("Monolith Lamoda product page enrichment finished", {
    mode,
    requested: targets.length,
    enriched: details.size,
  });

  return details;
}

function shouldReadLamodaProductPage(
  product: LamodaTileProduct,
  mode: "off" | "missing" | "all",
): boolean {
  if (mode === "off") {
    return false;
  }

  if (mode === "all") {
    return true;
  }

  // Lamoda listing does not expose reliable size data, so `missing` enriches each product page.
  return true;
}

async function readLamodaProductPageWithRetries(
  context: BrowserContext,
  product: LamodaTileProduct,
  config: MonolithConfig,
): Promise<LamodaProductPageDetails | undefined> {
  const attempts = Math.max(1, config.catalog.lamodaProductPageRetryAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const page = await createLamodaPage(context);

    try {
      const result = await readLamodaProductPage(page, product.productUrl, config);

      if (
        result.title ||
        result.brand ||
        result.sizes.length > 0 ||
        result.colors.length > 0 ||
        result.imageUrl
      ) {
        return result;
      }

      lastError = new Error("Lamoda product page returned no useful data");
    } catch (error) {
      lastError = error;
    } finally {
      if (!page.isClosed()) {
        await page.close();
      }
    }

    if (attempt < attempts) {
      await sleep(config.catalog.lamodaProductRetryDelayMs * attempt);
    }
  }

  logger.debug("Monolith Lamoda product page enrichment skipped", {
    sku: product.sku,
    productUrl: product.productUrl,
    error: errorMessage(lastError),
  });

  return undefined;
}

async function readLamodaProductPage(
  page: Page,
  url: string,
  config: MonolithConfig,
): Promise<LamodaProductPageDetails> {
  const response = await page.goto(url, {
    waitUntil: config.catalog.browserWaitUntil,
    timeout: config.catalog.lamodaProductPageTimeoutMs,
  });

  await humanPause(page, 700, 1_500);
  await acceptLamodaCookieBanner(page);
  await warmUpLamodaLazyImages(page);

  let status = response?.status();
  let extracted = await extractLamodaProductPage(page);

  if (!status && isLamodaRejectedPage(extracted.title, extracted.bodyPreview)) {
    status = 403;
  }

  if (status === 403 && config.catalog.lamodaSecurityWaitMs > 0) {
    logger.warn("Monolith Lamoda product security page detected; waiting before reload", {
      productUrl: url,
      waitMs: config.catalog.lamodaSecurityWaitMs,
    });
    await page.waitForTimeout(config.catalog.lamodaSecurityWaitMs);
    const reloadResponse = await page.reload({
      waitUntil: config.catalog.browserWaitUntil,
      timeout: config.catalog.lamodaProductPageTimeoutMs,
    });
    status = reloadResponse?.status() ?? status;
    await humanPause(page, 700, 1_500);
    await acceptLamodaCookieBanner(page);
    await warmUpLamodaLazyImages(page);
    extracted = await extractLamodaProductPage(page);

    if (!status && isLamodaRejectedPage(extracted.title, extracted.bodyPreview)) {
      status = 403;
    }
  }

  const tags = uniqueStrings([
    extracted.titleText,
    extracted.brand,
    extracted.url,
    ...extracted.tags,
    ...extracted.colors,
    ...extracted.sizes,
  ].filter((item): item is string => Boolean(item)));

  return {
    title: extracted.titleText,
    brand: extracted.brand,
    sizes: uniqueStrings(extracted.sizes),
    colors: uniqueStrings([
      ...readLamodaColors(tags),
      ...readLamodaColors([extracted.url]),
    ]),
    price: priceFromTexts(extracted.priceText, extracted.oldPriceText),
    imageUrl: extracted.imageUrl ? absolutizeLamodaUrl(extracted.imageUrl, extracted.url) : undefined,
    tags,
    status,
  };
}

async function extractLamodaProductPage(page: Page): Promise<LamodaExtractedProductPage> {
  return page.evaluate(
    new Function(LAMODA_PRODUCT_EXTRACT_SCRIPT) as any,
  ) as Promise<LamodaExtractedProductPage>;
}

function readLamodaColors(values: Array<string | undefined>): string[] {
  const source = values.filter(Boolean).join(" ").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\u0431\u0435\u043b|white/i, RU.colors.white],
    [/\u0447\u0435\u0440\u043d|black/i, RU.colors.black],
    [/\u0441\u0435\u0440|gray|grey/i, RU.colors.gray],
    [/\u0441\u0438\u043d|blue|navy|\u0434\u0435\u043d\u0438\u043c/i, RU.colors.blue],
    [/\u0433\u043e\u043b\u0443\u0431|light blue/i, RU.colors.lightBlue],
    [/\u0431\u0435\u0436|beige/i, RU.colors.beige],
    [/\u043a\u043e\u0440\u0438\u0447|brown/i, RU.colors.brown],
    [/\u0437\u0435\u043b\u0435\u043d|green|\u0445\u0430\u043a\u0438|khaki/i, RU.colors.green],
    [/\u043e\u043b\u0438\u0432|olive/i, RU.colors.olive],
    [/\u043a\u0440\u0430\u0441\u043d|red/i, RU.colors.red],
    [/\u0431\u043e\u0440\u0434\u043e\u0432|burgundy/i, RU.colors.burgundy],
    [/\u0440\u043e\u0437\u043e\u0432|pink/i, RU.colors.pink],
    [/\u0436\u0435\u043b\u0442|yellow/i, RU.colors.yellow],
    [/\u043e\u0440\u0430\u043d\u0436|orange/i, RU.colors.orange],
    [/\u0444\u0438\u043e\u043b\u0435\u0442|purple|violet/i, RU.colors.purple],
  ];

  return rules
    .filter(([pattern]) => pattern.test(source))
    .map(([, color]) => color);
}

function priceFromTexts(priceText: string | undefined, oldPriceText: string | undefined): GarmentCatalogItem["price"] {
  const prices = [priceText, oldPriceText]
    .map((text) => numberValue(text))
    .filter((price): price is number => Boolean(price && price > 0));
  const amount = prices.length ? Math.min(...prices) : undefined;

  if (!amount) {
    return undefined;
  }

  const oldAmount = prices.length > 1 ? Math.max(...prices) : undefined;

  return {
    amount,
    currency: "RUB",
    ...(oldAmount && oldAmount > amount ? { oldAmount } : {}),
  };
}

function buildLamodaDescription(details: {
  title: string;
  brandName?: string;
  category: string;
  colors: string[];
  sizes: string[];
  price?: GarmentCatalogItem["price"];
}): string | undefined {
  const priceText = details.price ? String(details.price.amount) + " " + details.price.currency : undefined;

  return uniqueStrings([
    details.brandName,
    details.category,
    details.colors.length ? RU.color + ": " + details.colors.join(", ") : undefined,
    details.sizes.length ? RU.sizes + ": " + details.sizes.slice(0, 12).join(", ") : undefined,
    priceText,
  ].filter((item): item is string => Boolean(item && item !== details.title))).join("; ") || undefined;
}

function inferCategory(value: string): string {
  const source = value.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/smoking|tuxedo|\u0441\u043c\u043e\u043a\u0438\u043d\u0433/i, RU.categories.tuxedo],
    [/kostyum|suit|\u043a\u043e\u0441\u0442\u044e\u043c/i, RU.categories.suit],
    [/pidzhak|zhaket|blazer|blejzer|\u043f\u0438\u0434\u0436\u0430\u043a|\u0436\u0430\u043a\u0435\u0442|\u0431\u043b\u0435\u0439\u0437\u0435\u0440/i, RU.categories.blazer],
    [/anorak|\u0430\u043d\u043e\u0440\u0430\u043a/i, RU.categories.anorak],
    [/dublenk|shearling|sheepskin|\u0434\u0443\u0431\u043b\u0435\u043d\u043a/i, RU.categories.shearling],
    [/kurtk|jacket|bomber|\u0432\u0435\u0442\u0440\u043e\u0432\u043a|\u043f\u0430\u0440\u043a\u0430|\u043f\u0443\u0445\u043e\u0432\u0438\u043a|\u0434\u0436\u0438\u043d\u0441\u043e\u0432\u043a|\u043a\u0443\u0440\u0442\u043a|\u0431\u043e\u043c\u0431\u0435\u0440/i, RU.categories.jacket],
    [/palto|coat|\u043f\u0430\u043b\u044c\u0442\u043e/i, RU.categories.coat],
    [/plash|trench|\u043f\u043b\u0430\u0449|\u0442\u0440\u0435\u043d\u0447/i, RU.categories.trench],
    [/kombinezon|jumpsuit|overall|\u043a\u043e\u043c\u0431\u0438\u043d\u0435\u0437\u043e\u043d/i, RU.categories.jumpsuit],
    [/rubash|shirt|\u0441\u043e\u0440\u043e\u0447\u043a|\u0440\u0443\u0431\u0430\u0448|bluzy|\u0431\u043b\u0443\u0437/i, RU.categories.shirt],
    [/bryuk|trouser|pants|slacks|chino|\u0447\u0438\u043d\u043e\u0441|\u0431\u0440\u044e\u043a|\u0434\u0436\u043e\u0433\u0433\u0435\u0440|\u0448\u0442\u0430\u043d/i, RU.categories.pants],
    [/longsliv|\u043b\u043e\u043d\u0433\u0441\u043b\u0438\u0432/i, RU.categories.longsleeve],
    [/futbol|t-shirt|tee|\u0444\u0443\u0442\u0431\u043e\u043b|\u0442\u0438\u0448\u0438\u0440\u0442/i, RU.categories.tshirt],
    [/dzhins|jeans|\u0434\u0436\u0438\u043d\u0441/i, RU.categories.jeans],
    [/hudi|hoodie|sweatshirt|\u0445\u0443\u0434\u0438|\u0442\u043e\u043b\u0441\u0442\u043e\u0432|\u0441\u0432\u0438\u0442\u0448\u043e\u0442/i, RU.categories.hoodie],
    [/sviter|sweater|jumper|pullover|\u0434\u0436\u0435\u043c\u043f\u0435\u0440|\u0441\u0432\u0438\u0442\u0435\u0440|\u043f\u0443\u043b\u043e\u0432\u0435\u0440/i, RU.categories.sweater],
    [/kardigan|cardigan|\u043a\u0430\u0440\u0434\u0438\u0433\u0430\u043d/i, RU.categories.cardigan],
    [/zhilet|vest|\u0436\u0438\u043b\u0435\u0442/i, RU.categories.vest],
    [/polo|\u043f\u043e\u043b\u043e/i, RU.categories.polo],
    [/mayk|tank top|\u043c\u0430\u0439\u043a/i, RU.categories.tank],
    [/top|\u0442\u043e\u043f/i, RU.categories.top],
    [/short|\u0448\u043e\u0440\u0442/i, RU.categories.shorts],
    [/yubk|skirt|\u044e\u0431\u043a/i, RU.categories.skirt],
    [/plat|dress|\u043f\u043b\u0430\u0442\u044c/i, RU.categories.dress],
    [/nosk|socks|\u0433\u043e\u043b\u044c\u0444|\u043d\u043e\u0441\u043e\u043a|\u043d\u043e\u0441\u043a\u0438/i, RU.categories.socks],
    [/bokser|brief|underwear|\u0431\u043e\u043a\u0441\u0435\u0440|\u0431\u0440\u0438\u0444|\u0445\u0438\u043f\u0441/i, RU.categories.underwear],
    [/pizham|pyjama|pajama|sleepwear|\u043f\u0438\u0436\u0430\u043c/i, RU.categories.pyjama],
    [/halat|robe|\u0445\u0430\u043b\u0430\u0442/i, RU.categories.robe],
    [/plavk|swim trunks|swimwear|\u043f\u043b\u0430\u0432\u043a/i, RU.categories.swimwear],
    [/obuv|shoes|sneaker|boot|\u0442\u0443\u0444\u043b|\u043a\u0440\u043e\u0441\u0441\u043e\u0432|\u0431\u043e\u0442\u0438\u043d|\u043b\u043e\u0444\u0435\u0440|\u043a\u0435\u0434/i, RU.categories.shoes],
  ];

  for (const [pattern, category] of rules) {
    if (pattern.test(source)) {
      return category;
    }
  }

  return RU.other;
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

function absolutizeLamodaUrl(value: string, pageUrl: string): string {
  if (value.startsWith("//")) {
    return "https:" + value;
  }

  return new URL(value, pageUrl).toString();
}

function isUsefulSearchTag(value: string | undefined): boolean {
  const normalized = value?.trim();

  return Boolean(
    normalized &&
    normalized.length <= 80 &&
    !/^[0-9]+$/.test(normalized)
  );
}

function labelForGender(gender: GarmentGender): string {
  if (gender === "male") {
    return RU.male;
  }

  if (gender === "female") {
    return RU.female;
  }

  return RU.unisex;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    const match = value.replace(/\s+/g, "").match(/\d+(?:[,.]\d+)?/);
    const parsed = match ? Number(match[0].replace(",", ".")) : Number.NaN;

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
