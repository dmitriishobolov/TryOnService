import type {
  MarketProductRef,
  MarketProvider,
  MarketSearchSelection,
} from "../../shared/contracts/index.js";
import { createLogger } from "../../shared/logger.js";
import type { WorkerConfig } from "../config/index.js";
import { aliexpressMarketplaceAdapter } from "./aliexpress/index.js";
import { limeMarketplaceAdapter } from "./lime/index.js";
import { ostinMarketplaceAdapter } from "./ostin/index.js";
import { ozonMarketplaceAdapter } from "./ozon/index.js";
import type {
  MarketplaceAdapter,
  MarketplaceSearchInput,
  MarketplaceSearchResult,
} from "./types.js";
import { tsumMarketplaceAdapter } from "./tsum/index.js";
import { tsumOutletMarketplaceAdapter } from "./tsumOutlet/index.js";
import { twoMoodMarketplaceAdapter } from "./twoMood/index.js";
import { MarketplaceError } from "./utils.js";
import { wildberriesMarketplaceAdapter } from "./wildberries/index.js";

const logger = createLogger("worker");

const adapters = new Map<MarketProvider, MarketplaceAdapter>(
  [
    aliexpressMarketplaceAdapter,
    ozonMarketplaceAdapter,
    wildberriesMarketplaceAdapter,
    tsumMarketplaceAdapter,
    tsumOutletMarketplaceAdapter,
    ostinMarketplaceAdapter,
    twoMoodMarketplaceAdapter,
    limeMarketplaceAdapter,
  ].map((adapter) => [adapter.provider, adapter]),
);

export async function searchMarketplaceProducts(params: {
  selection: MarketSearchSelection;
  config: WorkerConfig;
  fallbackQuery?: string;
  signal?: AbortSignal;
}): Promise<MarketProductRef[]> {
  if (!params.config.market.enabled) {
    throw new MarketplaceError(
      "market_disabled",
      "Marketplace search is disabled by MARKET_ENABLED=false",
      false,
    );
  }

  const query = (params.selection.query ?? params.fallbackQuery ?? "").trim();

  if (!query) {
    throw new MarketplaceError(
      "market_query_required",
      "Marketplace search requires payload.market.query or payload.text",
      false,
    );
  }

  const providers = resolveProviders(params.selection, params.config);
  const limit = resolveLimit(params.selection.limit, params.config.market.searchLimit);

  logger.info("Marketplace search started", {
    query,
    providers,
    limit,
  });

  const settled = await Promise.allSettled(
    providers.map((provider) =>
      searchProvider({
        provider,
        query,
        selection: params.selection,
        config: params.config,
        signal: params.signal,
      }),
    ),
  );
  const products: MarketProductRef[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      products.push(...result.value.products);
      continue;
    }

    logger.warn("Marketplace provider search failed", {
      query,
      error: result.reason,
    });
  }

  if (products.length === 0 && settled.some((result) => result.status === "rejected")) {
    throw new MarketplaceError(
      "market_products_unavailable",
      "Marketplace providers returned no products",
      true,
    );
  }

  const uniqueProducts = dedupeProducts(products).slice(0, limit);

  logger.info("Marketplace search finished", {
    query,
    providers,
    products: uniqueProducts.length,
  });

  return uniqueProducts;
}

function resolveProviders(
  selection: MarketSearchSelection,
  config: WorkerConfig,
): MarketProvider[] {
  const requested = selection.providers?.length
    ? selection.providers
    : config.market.providers;
  const configured = requested.filter((provider) => {
    const adapter = adapters.get(provider);

    return adapter?.isConfigured(config) ?? false;
  });

  if (configured.length === 0) {
    throw new MarketplaceError(
      "market_provider_not_configured",
      `No configured marketplace providers for request: ${requested.join(", ")}`,
      false,
    );
  }

  return configured;
}

async function searchProvider(
  input: MarketplaceSearchInput & { provider: MarketProvider },
): Promise<MarketplaceSearchResult> {
  const adapter = adapters.get(input.provider);

  if (!adapter) {
    throw new MarketplaceError(
      "market_provider_unsupported",
      `Unsupported marketplace provider: ${input.provider}`,
      false,
    );
  }

  return adapter.search(input);
}

function resolveLimit(
  requested: number | undefined,
  fallback: number,
): number {
  return Math.min(Math.max(requested ?? fallback, 1), 100);
}

function dedupeProducts(products: MarketProductRef[]): MarketProductRef[] {
  const seen = new Set<string>();
  const deduped: MarketProductRef[] = [];

  for (const product of products) {
    const key = `${product.provider}:${product.productId}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(product);
  }

  return deduped;
}
