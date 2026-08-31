export type ImageKind = "telegram-input" | "tryon-result" | "catalog-image";
export type GarmentGender = "male" | "female" | "unisex";
export type SizePreference = "any" | "xs-s" | "m-l" | "xl-xxl";
export type PricePreference = "any" | "under-10k" | "under-30k" | "under-100k" | "over-100k";

export interface IdealOutfitPreferences {
  userWish?: string;
  sizePreference: SizePreference;
  pricePreference: PricePreference;
}

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

export interface GarmentCatalogPrice {
  amount: number;
  currency: string;
  oldAmount?: number;
}

export interface GarmentCatalogItem {
  id: string;
  category: string;
  gender: GarmentGender;
  title: string;
  description?: string;
  sizes: string[];
  colors: string[];
  price?: GarmentCatalogPrice;
  tags: string[];
  productUrl: string;
  imageUrl: string;
  imageFile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogPreferenceFilter {
  sizePreference?: SizePreference;
  pricePreference?: PricePreference;
}

export interface CatalogCategoryTagHints {
  category: string;
  itemCount: number;
  genderCounts: Partial<Record<GarmentGender, number>>;
  aliases: string[];
  colors: string[];
  tags: string[];
}

export interface OutfitCategoryRequest {
  category: string;
  query: string;
  gender?: GarmentGender;
  color?: string;
  notes?: string;
  userWish?: string;
  sizePreference?: SizePreference;
  pricePreference?: PricePreference;
  requiredTags?: string[];
  preferredTags?: string[];
  avoidTags?: string[];
}

export interface IdealOutfitOption {
  styleName?: string;
  summary?: string;
  targetGender?: GarmentGender;
  userWish?: string;
  sizePreference?: SizePreference;
  pricePreference?: PricePreference;
  categories: OutfitCategoryRequest[];
}

export interface IdealOutfitPlan {
  accepted: boolean;
  rejectionMessage?: string;
  targetGender?: GarmentGender;
  userWish?: string;
  sizePreference?: SizePreference;
  pricePreference?: PricePreference;
  styleName?: string;
  summary?: string;
  categories: OutfitCategoryRequest[];
  options: IdealOutfitOption[];
}

export interface OutfitCandidateGroup {
  request: OutfitCategoryRequest;
  candidates: GarmentCatalogItem[];
}

export interface OutfitCandidateImageReviewCandidate {
  item: GarmentCatalogItem;
  image: ImageData;
}

export interface OutfitCandidateImageReviewGroup {
  request: OutfitCategoryRequest;
  candidates: OutfitCandidateImageReviewCandidate[];
}

export interface OutfitCandidateReviewRejection {
  itemId: string;
  reason?: string;
}

export interface OutfitCandidateReviewGroupResult {
  groupIndex: number;
  category: string;
  acceptedItemIds: string[];
  rejected: OutfitCandidateReviewRejection[];
}

export interface OutfitCandidateVisualReview {
  groups: OutfitCandidateReviewGroupResult[];
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
