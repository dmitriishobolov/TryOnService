import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  GarmentCatalogCategory,
  GarmentCatalogItem,
  GarmentCatalogNodeSearchRequest,
  StorageCatalogEntry,
  StorageCatalogEntryInput,
  StorageCatalogEntryKind,
  StorageCatalogNodeLookupRequest,
} from "../../shared/contracts/index.js";
import {
  normalizeStorageKey,
  StorageObjectNotFoundError,
  type ObjectStorage,
} from "../../shared/storage/index.js";

interface StorageCatalogFile {
  version: 1;
  entries: StorageCatalogEntry[];
}

export interface StorageCatalogIndexOptions {
  catalogPath: string;
  storageId: string;
  objects: ObjectStorage;
}

export class StorageCatalogIndex {
  private readonly entries = new Map<string, StorageCatalogEntry>();
  private persistQueue = Promise.resolve();

  constructor(private readonly options: StorageCatalogIndexOptions) {
    this.load();
  }

  async upsert(input: StorageCatalogEntryInput): Promise<StorageCatalogEntry> {
    const cacheKey = normalizeCatalogCacheKey(input.cacheKey);
    const objectKey = normalizeStorageKey(input.objectKey);
    const object = await this.options.objects.headObject(objectKey);

    if (!object) {
      throw new StorageObjectNotFoundError(objectKey);
    }

    const now = new Date().toISOString();
    const mapKey = entryMapKey(input.kind, cacheKey);
    const previous = this.entries.get(mapKey);
    const entry: StorageCatalogEntry = {
      cacheKey,
      kind: input.kind,
      object: {
        ...object,
        storageId: this.options.storageId,
      },
      metadata: input.metadata,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };

    this.entries.set(mapKey, entry);
    await this.persist();

    return entry;
  }

  async lookup(
    request: StorageCatalogNodeLookupRequest,
  ): Promise<StorageCatalogEntry[]> {
    const kinds = new Set(request.kinds);
    const entries: StorageCatalogEntry[] = [];
    let changed = false;

    for (const cacheKey of request.cacheKeys.map(normalizeCatalogCacheKey)) {
      for (const kind of resolveLookupKinds(kinds)) {
        const mapKey = entryMapKey(kind, cacheKey);
        const entry = this.entries.get(mapKey);

        if (!entry) {
          continue;
        }

        if (isExpired(entry)) {
          this.entries.delete(mapKey);
          changed = true;
          continue;
        }

        const object = await this.options.objects.headObject(entry.object.key);

        if (!object) {
          this.entries.delete(mapKey);
          changed = true;
          continue;
        }

        entries.push({
          ...entry,
          object: {
            ...object,
            storageId: this.options.storageId,
          },
        });
      }
    }

    if (changed) {
      await this.persist();
    }

    return entries;
  }

  async garmentCategories(): Promise<GarmentCatalogCategory[]> {
    const counts = new Map<string, number>();
    let changed = false;

    for (const [mapKey, entry] of this.entries) {
      if (entry.kind !== "garment-item") {
        continue;
      }

      if (isExpired(entry)) {
        this.entries.delete(mapKey);
        changed = true;
        continue;
      }

      const item = garmentItemFromEntry(entry, this.options.storageId);

      if (!item) {
        continue;
      }

      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }

    if (changed) {
      await this.persist();
    }

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async searchGarments(
    request: GarmentCatalogNodeSearchRequest,
  ): Promise<GarmentCatalogItem[]> {
    const categories = normalizedSet(request.categories);
    const tags = normalizedSet(request.tags);
    const queryTokens = tokenize([request.text, ...(request.tags ?? [])].join(" "));
    const limit = normalizeLimit(request.limit);
    const matches: Array<{ item: GarmentCatalogItem; score: number }> = [];
    let changed = false;

    for (const [mapKey, entry] of this.entries) {
      if (entry.kind !== "garment-item") {
        continue;
      }

      if (isExpired(entry)) {
        this.entries.delete(mapKey);
        changed = true;
        continue;
      }

      const object = await this.options.objects.headObject(entry.object.key);

      if (!object) {
        this.entries.delete(mapKey);
        changed = true;
        continue;
      }

      const item = garmentItemFromEntry(
        {
          ...entry,
          object: {
            ...object,
            storageId: this.options.storageId,
          },
        },
        this.options.storageId,
      );

      if (!item) {
        continue;
      }

      const score = garmentSearchScore(item, categories, tags, queryTokens);

      if (score > 0) {
        matches.push({ item, score });
      }
    }

    if (changed) {
      await this.persist();
    }

    return matches
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
      .slice(0, limit)
      .map((match) => match.item);
  }

  private load(): void {
    const catalogPath = resolve(this.options.catalogPath);

    if (!existsSync(catalogPath)) {
      return;
    }

    const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as StorageCatalogFile;

    if (raw.version !== 1 || !Array.isArray(raw.entries)) {
      return;
    }

    for (const entry of raw.entries) {
      if (!isPersistedCatalogEntry(entry) || isExpired(entry)) {
        continue;
      }

      this.entries.set(
        entryMapKey(entry.kind, normalizeCatalogCacheKey(entry.cacheKey)),
        {
          ...entry,
          cacheKey: normalizeCatalogCacheKey(entry.cacheKey),
          object: {
            ...entry.object,
            storageId: this.options.storageId,
            key: normalizeStorageKey(entry.object.key),
          },
        },
      );
    }
  }

  private persist(): Promise<void> {
    const nextPersist = this.persistQueue.then(
      () => this.persistNow(),
      () => this.persistNow(),
    );
    this.persistQueue = nextPersist.catch(() => undefined);

    return nextPersist;
  }

  private async persistNow(): Promise<void> {
    const catalogPath = resolve(this.options.catalogPath);
    const payload: StorageCatalogFile = {
      version: 1,
      entries: [...this.entries.values()],
    };
    const tempPath = `${catalogPath}.${randomUUID()}.tmp`;

    await mkdir(dirname(catalogPath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tempPath, catalogPath);
  }
}

function entryMapKey(kind: StorageCatalogEntryKind, cacheKey: string): string {
  return `${kind}:${cacheKey}`;
}

function normalizeCatalogCacheKey(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function resolveLookupKinds(
  kinds: Set<StorageCatalogEntryKind | undefined>,
): StorageCatalogEntryKind[] {
  const requested = [...kinds].filter(
    (kind): kind is StorageCatalogEntryKind => Boolean(kind),
  );

  return requested.length
    ? requested
    : [
        "product-card-image",
        "product-card-metadata",
        "garment-item",
      ];
}

function isExpired(entry: StorageCatalogEntry): boolean {
  return Boolean(entry.expiresAt && Date.now() > new Date(entry.expiresAt).getTime());
}

function isPersistedCatalogEntry(value: unknown): value is StorageCatalogEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "cacheKey" in value &&
    typeof value.cacheKey === "string" &&
    "kind" in value &&
    isCatalogKind(value.kind) &&
    "object" in value &&
    typeof value.object === "object" &&
    value.object !== null &&
    "key" in value.object &&
    typeof value.object.key === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}

function isCatalogKind(value: unknown): value is StorageCatalogEntryKind {
  return (
    value === "product-card-image" ||
    value === "product-card-metadata" ||
    value === "garment-item"
  );
}

function garmentItemFromEntry(
  entry: StorageCatalogEntry,
  storageId: string,
): GarmentCatalogItem | undefined {
  if (entry.kind !== "garment-item") {
    return undefined;
  }

  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  const category = readString(metadata.category);

  if (!category) {
    return undefined;
  }

  const title = readString(metadata.title) ?? entry.cacheKey;
  const tags = readStringArray(metadata.tags)
    .concat(readStringArray(metadata.colorTags))
    .concat(readStringArray(metadata.styleTags))
    .concat(readStringArray(metadata.materialTags));

  return {
    id: readString(metadata.id) ?? entry.cacheKey,
    cacheKey: entry.cacheKey,
    storageId,
    category,
    title,
    ...optionalStringField("description", metadata.description),
    tags: uniqueStrings(tags),
    ...optionalStringField("price", metadata.price),
    ...optionalStringField("currency", metadata.currency),
    ...optionalStringField("store", metadata.store),
    ...optionalStringField("productUrl", metadata.productUrl),
    image: {
      ...entry.object,
      storageId,
    },
    metadata,
  };
}

function garmentSearchScore(
  item: GarmentCatalogItem,
  categories: Set<string>,
  tags: Set<string>,
  queryTokens: string[],
): number {
  const category = normalizeSearchText(item.category);

  if (categories.size > 0 && !categories.has(category)) {
    return 0;
  }

  const haystack = normalizeSearchText(
    [item.category, item.title, item.description, item.store, item.tags.join(" ")]
      .filter(Boolean)
      .join(" "),
  );
  let score = categories.size > 0 ? 50 : 1;

  for (const tag of tags) {
    if (haystack.includes(tag)) {
      score += 8;
    }
  }

  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
  }

  if (tags.size > 0 || queryTokens.length > 0) {
    return score > (categories.size > 0 ? 50 : 1) ? score : 0;
  }

  return score;
}

function normalizedSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map(normalizeSearchText)
      .filter(Boolean),
  );
}

function normalizeLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(1, Math.min(100, Math.floor(value)));
}

function tokenize(value: string): string[] {
  return uniqueStrings(
    normalizeSearchText(value)
      .split(/[^a-z0-9а-яё]+/iu)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, "е");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function optionalStringField<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  const text = readString(value);

  return text ? ({ [key]: text } as Partial<Record<K, string>>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
