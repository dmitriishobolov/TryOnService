import {
  createPublicHtmlCatalogAdapter,
  type PublicHtmlCatalogSearchUrlParams,
} from "../publicHtmlCatalog.js";

const limeCategoryRoutes: Array<{
  pattern: RegExp;
  paths: string[];
}> = [
  {
    pattern: /рубаш|блуз|shirt|blouse/i,
    paths: [
      "/ru_ru/catalog/men_shirts",
      "/ru_ru/catalog/women_shirts_all",
      "/ru_ru/catalog/women_special_prices_shirts_and_blouses",
    ],
  },
  {
    pattern: /жакет|жилет|пиджак|блейзер|vest|waistcoat|jacket|blazer/i,
    paths: ["/ru_ru/catalog/women_blazers_waistcoats"],
  },
  {
    pattern: /брюк|чинос|trouser|pants|chino/i,
    paths: ["/ru_ru/catalog/trousers", "/ru_ru/catalog/men_trousers"],
  },
  {
    pattern: /джинс|jeans|denim/i,
    paths: ["/ru_ru/catalog/women_jeans", "/ru_ru/catalog/men_jeans"],
  },
  {
    pattern: /куртк|бомбер|пальто|верхн|coat|outerwear|bomber/i,
    paths: ["/ru_ru/catalog/outerwear"],
  },
  {
    pattern: /футбол|лонгслив|поло|майк|t-?shirt|longsleeve|polo|top/i,
    paths: ["/ru_ru/catalog/t_shirts"],
  },
  {
    pattern: /кардиган|джемпер|свитер|трикотаж|knit|sweater|cardigan/i,
    paths: ["/ru_ru/catalog/knitwear"],
  },
  {
    pattern: /плать|dress/i,
    paths: ["/ru_ru/catalog/women_dresses"],
  },
  {
    pattern: /юбк|шорт|skirt|shorts/i,
    paths: ["/ru_ru/catalog/women_skirts", "/ru_ru/catalog/shorty"],
  },
  {
    pattern: /обув|лофер|ботин|кроссов|сапог|туфл|shoe|lofer|boot|sneaker/i,
    paths: ["/ru_ru/catalog/all_shoes"],
  },
  {
    pattern: /сумк|ремень|аксессуар|bag|belt|accessor/i,
    paths: [
      "/ru_ru/catalog/bags",
      "/ru_ru/catalog/belts",
      "/ru_ru/catalog/women_accessories_and_jewellery",
    ],
  },
];

export const limeMarketplaceAdapter = createPublicHtmlCatalogAdapter({
  provider: "lime",
  displayName: "LIMÉ",
  readConfig: (config) => config.market.lime,
  buildSearchUrls: buildLimeSearchUrls,
  productLinkPattern: /\/ru_ru\/product\/[^?\s"'<>\\]+/i,
  extractProductId: (productUrl) =>
    productUrl.match(/\/ru_ru\/product\/([^/?#]+)/i)?.[1],
  referer: "https://limestore.com/ru_ru",
});

function buildLimeSearchUrls(params: PublicHtmlCatalogSearchUrlParams): string[] {
  const paths = resolveLimeCategoryPaths(
    `${params.query} ${params.selection.category ?? ""}`,
  );

  return paths.map((path) =>
    buildPagedUrl(path, params.page, params.marketConfig.publicProductBaseUrl),
  );
}

function resolveLimeCategoryPaths(value: string): string[] {
  const paths: string[] = [];

  for (const route of limeCategoryRoutes) {
    if (route.pattern.test(value)) {
      paths.push(...route.paths);
    }
  }

  paths.push("/ru_ru/catalog/men_shirts");
  paths.push("/ru_ru/catalog/women_blazers_waistcoats");

  return [...new Set(paths)];
}

function buildPagedUrl(path: string, page: number, baseUrl: string): string {
  const url = new URL(path, baseUrl);

  if (page > 1) {
    url.searchParams.set("page", String(page));
  }

  return url.toString();
}
