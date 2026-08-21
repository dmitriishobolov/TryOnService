import { createPublicHtmlCatalogAdapter } from "../publicHtmlCatalog.js";

export const ostinMarketplaceAdapter = createPublicHtmlCatalogAdapter({
  provider: "ostin",
  displayName: "O'STIN",
  readConfig: (config) => config.market.ostin,
  productLinkPattern: /\/product\/[^/\s"'<>\\]+\/\d+\/?/i,
  extractProductId: (productUrl) =>
    productUrl.match(/\/product\/[^/?#]+\/(\d+)(?:[/?#]|$)/i)?.[1],
  referer: "https://ostin.com/",
});
