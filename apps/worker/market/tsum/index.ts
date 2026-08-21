import { createPublicHtmlCatalogAdapter } from "../publicHtmlCatalog.js";

export const tsumMarketplaceAdapter = createPublicHtmlCatalogAdapter({
  provider: "tsum",
  displayName: "TSUM",
  readConfig: (config) => config.market.tsum,
  productLinkPattern: /\/product\/[^/\s"'<>\\]+\/?/i,
  extractProductId: (productUrl) => {
    const match = productUrl.match(/\/product\/([^/?#]+)/i);
    const slug = match?.[1];

    return slug?.match(/^([a-z0-9]+)(?:-|$)/i)?.[1] ?? slug;
  },
  referer: "https://www.tsum.ru/",
});
