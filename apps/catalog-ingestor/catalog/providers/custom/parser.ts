import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { readCatalogPage } from "../../../browser/pageReader.js";
import { createLogger } from "../../../../shared/logger.js";
import type {
  CatalogGarmentDraft,
  CatalogImageSource,
  CatalogProviderContext,
} from "../../types.js";

const logger = createLogger("catalog-ingestor");

export async function collectCustomCatalog(
  context: CatalogProviderContext,
): Promise<CatalogGarmentDraft[]> {
  const sourceFile = context.customSourceFile?.trim();

  if (!sourceFile) {
    await readCustomUrlIfConfigured(context);
    return [];
  }

  const payload = JSON.parse(await readFile(resolve(sourceFile), "utf8")) as unknown;
  const items = readItems(payload).slice(0, context.batchSize);

  return Promise.all(
    items.map((item, index) => normalizeCustomCatalogItem(item, index)),
  );
}

async function readCustomUrlIfConfigured(context: CatalogProviderContext): Promise<void> {
  const url = context.customUrl?.trim();

  if (!url) {
    return;
  }

  const page = await readCatalogPage({
    url,
    userAgent: context.userAgent,
    headless: context.browserHeadless,
    timeoutMs: context.browserTimeoutMs,
    waitUntil: context.browserWaitUntil,
    textMaxChars: context.browserTextMaxChars,
    linksMaxCount: context.browserLinksMaxCount,
  });

  logger.info("Custom parser page read", {
    requestedUrl: page.requestedUrl,
    finalUrl: page.url,
    status: page.status,
    ok: page.ok,
    title: page.title,
    htmlLength: page.html.length,
    textLength: page.text.length,
    links: page.links.length,
  });

  logger.debug("Custom parser page text preview", {
    title: page.title,
    textPreview: page.text.slice(0, 1_000),
    firstLinks: page.links.slice(0, 10),
  });
}

async function normalizeCustomCatalogItem(
  value: unknown,
  index: number,
): Promise<CatalogGarmentDraft> {
  const record = readRecord(value, `items[${index}]`);
  const image = await readImageSource(record, index);

  return {
    provider: "custom",
    externalId: requiredString(record, "externalId", index),
    productUrl: requiredString(record, "productUrl", index),
    title: requiredString(record, "title", index),
    category: requiredString(record, "category", index),
    description: optionalString(record.description),
    tags: optionalStringList(record.tags),
    colorTags: optionalStringList(record.colorTags),
    styleTags: optionalStringList(record.styleTags),
    materialTags: optionalStringList(record.materialTags),
    price: optionalScalarString(record.price),
    currency: optionalString(record.currency),
    store: optionalString(record.store),
    image,
    metadata: optionalRecord(record.metadata),
    cacheKey: optionalString(record.cacheKey),
  };
}

function readItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (isRecord(payload) && Array.isArray(payload.items)) {
    return payload.items;
  }

  throw new Error("Custom catalog source must be an array or an object with items array");
}

async function readImageSource(
  record: Record<string, unknown>,
  index: number,
): Promise<CatalogImageSource> {
  const imageRecord = isRecord(record.image) ? record.image : {};
  const url = optionalString(imageRecord.url) ?? optionalString(record.imageUrl);
  const path = optionalString(imageRecord.path) ?? optionalString(record.imagePath);
  const contentType =
    optionalString(imageRecord.contentType) ?? optionalString(record.imageContentType);
  const filename =
    optionalString(imageRecord.filename) ??
    optionalString(record.imageFilename) ??
    filenameFromSource(url ?? path);

  if (url) {
    return {
      url,
      contentType,
      filename,
    };
  }

  if (path) {
    return {
      data: await readFile(resolve(path)),
      contentType: contentType ?? contentTypeFromFilename(path),
      filename: filename ?? basename(path),
    };
  }

  throw new Error(
    `items[${index}] must contain image.url, image.path, imageUrl or imagePath`,
  );
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = optionalString(record[field]);

  if (!value) {
    throw new Error(`items[${index}].${field} is required`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalScalarString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return optionalString(value);
}

function optionalStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return splitStringList(value);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .flatMap((item) => (typeof item === "string" ? splitStringList(item) : []))
    .filter(Boolean);

  return items.length > 0 ? [...new Set(items)] : undefined;
}

function splitStringList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filenameFromSource(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const filename = url.pathname.split("/").filter(Boolean).at(-1);

    return filename || undefined;
  } catch {
    return basename(value);
  }
}

function contentTypeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }

  if (extension === "png") {
    return "image/png";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  return "image/jpeg";
}
