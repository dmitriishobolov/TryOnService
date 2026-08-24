import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
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
    value === "product-card-metadata"
  );
}
