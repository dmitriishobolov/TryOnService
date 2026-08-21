import type {
  MarketProductRef,
  MarketProvider,
  MarketSearchSelection,
} from "../../shared/contracts/index.js";
import type { WorkerConfig } from "../config/index.js";

export interface MarketplaceSearchInput {
  query: string;
  selection: MarketSearchSelection;
  config: WorkerConfig;
  signal?: AbortSignal;
}

export interface MarketplaceSearchResult {
  provider: MarketProvider;
  products: MarketProductRef[];
}

export interface MarketplaceAdapter {
  provider: MarketProvider;
  displayName: string;
  isConfigured(config: WorkerConfig): boolean;
  search(input: MarketplaceSearchInput): Promise<MarketplaceSearchResult>;
}

