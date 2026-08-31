import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { MonolithConfig } from "../config.js";
import type {
  CatalogCategoryTagHints,
  CatalogPreferenceFilter,
  GarmentCatalogItem,
  ImageData,
  OutfitCategoryRequest,
  PricePreference,
  SizePreference,
  StoredImage,
} from "../types.js";
import { sleep } from "../utils/http.js";
import { createLogger } from "../utils/logger.js";
import { LocalFileStorage } from "../storage/localFileStorage.js";
import { LocalCatalogStore } from "./store.js";
import { parseLamodaCatalogUrl } from "./providers/lamoda/parser.js";
import { downloadCatalogImage, parseTsumCatalogUrl } from "./providers/tsum/parser.js";

const logger = createLogger("monolith");

export interface CatalogMaterializeOptions {
  downloadImages?: boolean;
  logImageSummary?: boolean;
  logImageProgress?: boolean;
}

export interface CatalogMaterializeResult {
  items: GarmentCatalogItem[];
  downloaded: number;
  reused: number;
  failed: number;
}

export class MonolithCatalog {
  private refreshPromise?: Promise<GarmentCatalogItem[]>;

  constructor(
    private readonly config: MonolithConfig,
    private readonly store: LocalCatalogStore,
    private readonly storage: LocalFileStorage,
  ) {}

  async ensureReady(): Promise<GarmentCatalogItem[]> {
    const items = await this.store.load();

    if (!this.config.catalog.enabled) {
      return items;
    }

    if (items.length > 0) {
      return items;
    }

    return this.refresh();
  }

  async refresh(): Promise<GarmentCatalogItem[]> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshNow().finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  async list(): Promise<GarmentCatalogItem[]> {
    await this.ensureReady();

    return this.store.list();
  }

  async categories(): Promise<string[]> {
    await this.ensureReady();

    return this.store.categories();
  }

  async categoryTagHints(): Promise<CatalogCategoryTagHints[]> {
    await this.ensureReady();

    return this.store.categoryTagHints();
  }

  async findCandidates(
    request: OutfitCategoryRequest,
    limit: number,
  ): Promise<GarmentCatalogItem[]> {
    await this.ensureReady();

    return this.store.findCandidates(request, limit);
  }

  async sizePreferenceCounts(
    baseFilter: CatalogPreferenceFilter = {},
  ): Promise<Record<SizePreference, number>> {
    await this.store.load();

    return this.store.sizePreferenceCounts(baseFilter);
  }

  async pricePreferenceCounts(
    baseFilter: CatalogPreferenceFilter = {},
  ): Promise<Record<PricePreference, number>> {
    await this.store.load();

    return this.store.pricePreferenceCounts(baseFilter);
  }

  async getImage(item: GarmentCatalogItem): Promise<ImageData> {
    const imageFilePath = item.imageFile
      ? join(this.config.storageRoot, item.imageFile)
      : undefined;

    if (imageFilePath && existsSync(imageFilePath)) {
      return {
        buffer: await readFile(imageFilePath),
        contentType: contentTypeFromFilename(catalogImageFilename(item)),
        filename: catalogImageFilename(item),
      };
    }

    const { image, stored } = await this.downloadAndStoreCatalogImage(item);

    await this.store.updateItem({
      ...item,
      imageFile: stored.relativePath,
    });

    return image;
  }

  async upsertParsedItems(
    items: GarmentCatalogItem[],
    options: CatalogMaterializeOptions = {},
  ): Promise<CatalogMaterializeResult> {
    await this.store.load();

    const shouldDownload = options.downloadImages ?? this.config.catalog.downloadImagesOnRefresh;
    const result = shouldDownload
      ? await this.materializeCatalogImages(items, options)
      : { items, downloaded: 0, reused: 0, failed: 0 };

    await this.store.upsertMany(result.items);

    return result;
  }

  private async refreshNow(): Promise<GarmentCatalogItem[]> {
    await this.store.load();

    if (!this.config.catalog.enabled) {
      return this.store.list();
    }

    const parsed: GarmentCatalogItem[] = [];

    const sources = [
      ...this.config.catalog.tsumSources,
      ...this.config.catalog.lamodaSources,
    ];

    for (const source of sources) {
      if (!this.config.catalog.providers.includes(source.provider)) {
        continue;
      }

      if (source.provider === "tsum") {
        parsed.push(...await parseTsumCatalogUrl(source.url, this.config, {
          gender: source.gender,
        }));
        continue;
      }

      if (source.provider === "lamoda") {
        parsed.push(...await parseLamodaCatalogUrl(source.url, this.config, {
          gender: source.gender,
        }));
      }
    }

    const result = this.config.catalog.downloadImagesOnRefresh
      ? await this.materializeCatalogImages(parsed)
      : { items: parsed, downloaded: 0, reused: 0, failed: 0 };

    logger.info("Monolith catalog refresh parsed items", {
      providers: this.config.catalog.providers,
      sources: sources.length,
      parsedItems: parsed.length,
      savedItems: result.items.length,
      downloadedImages: result.downloaded,
      reusedImages: result.reused,
      failedImages: result.failed,
      downloadImagesOnRefresh: this.config.catalog.downloadImagesOnRefresh,
    });

    const saved = await this.store.replaceAll(result.items);

    logger.info("Monolith catalog refresh saved", {
      totalItems: saved.length,
      categories: this.store.categories(),
    });

    return saved;
  }

  private async materializeCatalogImages(
    items: GarmentCatalogItem[],
    options: CatalogMaterializeOptions = {},
  ): Promise<CatalogMaterializeResult> {
    const readyItems: GarmentCatalogItem[] = [];
    const concurrency = Math.max(1, this.config.catalog.imageDownloadConcurrency);
    const logImageSummary = options.logImageSummary ?? true;
    const logImageProgress = options.logImageProgress ?? true;
    let cursor = 0;
    let downloaded = 0;
    let reused = 0;
    let failed = 0;

    const runWorker = async (): Promise<void> => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;

        if (!item) {
          continue;
        }

        const existing = this.store.getById(item.id);

        if (existing && this.hasLocalImage(existing)) {
          readyItems.push(markReadyLocalImage({
            ...item,
            imageFile: existing.imageFile,
          }));
          reused += 1;
          continue;
        }

        try {
          const { stored } = await this.downloadAndStoreCatalogImage(item);

          readyItems.push(markReadyLocalImage({
            ...item,
            imageFile: stored.relativePath,
          }));
          downloaded += 1;

          if (logImageProgress && downloaded % 500 === 0) {
            logger.info("Monolith catalog images download progress", {
              downloaded,
              reused,
              failed,
              total: items.length,
            });
          }
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);

          failed += 1;
          readyItems.push(markMissingLocalImage(item, errorText));
          logger.warn("Monolith catalog image download failed", {
            itemId: item.id,
            productUrl: item.productUrl,
            imageUrl: item.imageUrl,
            error: errorText,
          });
        }

        if (this.config.catalog.imageDownloadDelayMs > 0) {
          await sleep(this.config.catalog.imageDownloadDelayMs);
        }
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(concurrency, Math.max(items.length, 1)) },
      () => runWorker(),
    ));

    if (logImageSummary) {
      logger.info("Monolith catalog images materialized", {
        total: items.length,
        savedItems: readyItems.length,
        downloaded,
        reused,
        failed,
      });
    }

    return {
      items: readyItems,
      downloaded,
      reused,
      failed,
    };
  }

  private hasLocalImage(item: GarmentCatalogItem): boolean {
    return Boolean(
      item.imageFile && existsSync(join(this.config.storageRoot, item.imageFile)),
    );
  }

  private async downloadAndStoreCatalogImage(
    item: GarmentCatalogItem,
  ): Promise<{ image: ImageData; stored: StoredImage }> {
    const downloaded = await downloadCatalogImage(item, this.config);
    const image: ImageData = {
      buffer: downloaded.image,
      contentType: downloaded.contentType,
      filename: catalogImageFilename(item),
    };
    const stored = await this.storage.saveImage("catalog-image", image, {
      catalogItemId: item.id,
      productUrl: item.productUrl,
    });

    return {
      image: {
        ...image,
        filename: stored.filename,
      },
      stored,
    };
  }
}

function markReadyLocalImage(item: GarmentCatalogItem): GarmentCatalogItem {
  return item;
}

function markMissingLocalImage(item: GarmentCatalogItem, _error: string): GarmentCatalogItem {
  return {
    ...item,
    imageFile: undefined,
  };
}

function catalogImageFilename(item: GarmentCatalogItem): string {
  return filenameFromPath(item.imageFile) ?? filenameFromUrl(item.imageUrl) ?? safeFilename(item.id) + ".jpg";
}

function filenameFromPath(value: string | undefined): string | undefined {
  return value?.split(/[\\/]/).filter(Boolean).at(-1);
}

function filenameFromUrl(value: string): string | undefined {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).at(-1) || undefined;
  } catch {
    return undefined;
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9а-яё._-]+/gi, "-").replace(/^-+|-+$/g, "") || "image";
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
