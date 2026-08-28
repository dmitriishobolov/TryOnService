import type { StorageObjectRef } from "../../shared/contracts/index.js";

export const catalogProviderNames = [
  "wildberries",
  "ozon",
  "aliexpress",
  "tsum",
  "tsum-outlet",
  "ostin",
  "2mood",
  "lime",
  "custom",
] as const;

export type CatalogProviderName = (typeof catalogProviderNames)[number];

export interface CatalogImageSource {
  url?: string;
  data?: Uint8Array;
  contentType?: string;
  filename?: string;
}

export interface CatalogGarmentDraft {
  provider: CatalogProviderName;
  externalId: string;
  productUrl: string;
  title: string;
  category: string;
  description?: string;
  tags?: string[];
  colorTags?: string[];
  styleTags?: string[];
  materialTags?: string[];
  price?: string;
  currency?: string;
  store?: string;
  image: CatalogImageSource;
  metadata?: Record<string, unknown>;
  cacheKey?: string;
}

export interface CatalogProviderContext {
  batchSize: number;
  userAgent: string;
  customSourceFile?: string;
  signal?: AbortSignal;
}

export interface CatalogProvider {
  name: CatalogProviderName;
  collect(context: CatalogProviderContext): Promise<CatalogGarmentDraft[]>;
}

export interface PublishedCatalogItem {
  cacheKey: string;
  provider: CatalogProviderName;
  object: StorageObjectRef;
}
