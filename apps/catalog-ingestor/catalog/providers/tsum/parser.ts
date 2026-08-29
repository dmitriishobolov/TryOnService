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
  void page;
  void context;

  return [];
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
