export type ImageKind = "telegram-input" | "tryon-result" | "catalog-image";
export type GarmentGender = "male" | "female" | "unisex";

export interface StoredImage {
  id: string;
  kind: ImageKind;
  absolutePath: string;
  relativePath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface ImageData {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

export interface GarmentCatalogItem {
  id: string;
  provider: string;
  externalId: string;
  productUrl: string;
  title: string;
  category: string;
  gender: GarmentGender;
  genderLabel: string;
  description?: string;
  brand?: string;
  store: string;
  price?: number;
  currency?: string;
  imageUrl: string;
  imageFilename: string;
  imageContentType?: string;
  localImagePath?: string;
  tags: string[];
  colorTags: string[];
  styleTags: string[];
  materialTags: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogCategoryTagHints {
  category: string;
  itemCount: number;
  aliases: string[];
  colors: string[];
  styles: string[];
  materials: string[];
  tags: string[];
}

export interface OutfitCategoryRequest {
  category: string;
  query: string;
  color?: string;
  notes?: string;
  requiredTags?: string[];
  preferredTags?: string[];
  avoidTags?: string[];
}

export interface IdealOutfitOption {
  styleName?: string;
  summary?: string;
  categories: OutfitCategoryRequest[];
}

export interface IdealOutfitPlan {
  accepted: boolean;
  rejectionMessage?: string;
  styleName?: string;
  summary?: string;
  categories: OutfitCategoryRequest[];
  options: IdealOutfitOption[];
}

export interface OutfitCandidateGroup {
  request: OutfitCategoryRequest;
  candidates: GarmentCatalogItem[];
}

export interface OutfitSelectionItem {
  category: string;
  itemId: string;
  reason?: string;
}

export interface OutfitSelection {
  styleName: string;
  summary: string;
  items: OutfitSelectionItem[];
}

export interface TryOnInput {
  person: ImageData;
  garments: ImageData[];
}

export interface TryOnOutput {
  provider: string;
  message: string;
  image?: ImageData;
  raw?: unknown;
}
