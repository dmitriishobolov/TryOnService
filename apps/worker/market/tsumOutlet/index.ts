import { createPublicHtmlCatalogAdapter } from "../publicHtmlCatalog.js";

export const tsumOutletMarketplaceAdapter = createPublicHtmlCatalogAdapter({
  provider: "tsum-outlet",
  displayName: "TSUM Outlet",
  readConfig: (config) => config.market.tsumOutlet,
  productLinkPattern: /\/product\/[^/\s"'<>\\]+\/?/i,
  extractProductId: (productUrl) => {
    const match = productUrl.match(/\/product\/([^/?#]+)/i);
    const slug = match?.[1];

    return slug?.match(/^([a-z0-9]+)(?:-|$)/i)?.[1] ?? slug;
  },
  referer: "https://outlet.tsum.ru/",
});
