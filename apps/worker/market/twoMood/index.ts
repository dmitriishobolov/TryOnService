import {
  createPublicHtmlCatalogAdapter,
  type PublicHtmlCatalogSearchUrlParams,
} from "../publicHtmlCatalog.js";

const twoMoodCategoryRoutes: Array<{
  pattern: RegExp;
  paths: string[];
}> = [
  {
    pattern: /рубаш|блуз|shirt|blouse/i,
    paths: ["/collection/rubashki/"],
  },
  {
    pattern: /брюк|чинос|trouser|pants|chino/i,
    paths: ["/collection/bruki/"],
  },
  {
    pattern: /джинс|jeans|denim/i,
    paths: ["/collection/dzhinsy/", "/collection/bruki/"],
  },
  {
    pattern: /жакет|жилет|пиджак|блейзер|vest|waistcoat|jacket|blazer/i,
    paths: ["/collection/zhakety/"],
  },
  {
    pattern: /куртк|бомбер|пальто|верхн|coat|outerwear|bomber/i,
    paths: ["/collection/verhnyaya_odezhda/", "/collection/zhakety/"],
  },
  {
    pattern: /футбол|лонгслив|топ|майк|t-?shirt|longsleeve|top/i,
    paths: ["/collection/futbolki/", "/collection/mayki_bodi_i_topy/"],
  },
  {
    pattern: /кардиган|джемпер|свитер|трикотаж|knit|sweater|cardigan/i,
    paths: ["/collection/vyazanyy_trikotazh/"],
  },
  {
    pattern: /плать|dress/i,
    paths: ["/collection/platya/"],
  },
  {
    pattern: /юбк|шорт|skirt|shorts/i,
    paths: ["/collection/yubki_i_shorty/"],
  },
  {
    pattern: /обув|лофер|ботин|кроссов|сапог|туфл|shoe|lofer|boot|sneaker/i,
    paths: ["/collection/obuv/"],
  },
  {
    pattern: /сумк|ремень|аксессуар|bag|belt|accessor/i,
    paths: ["/collection/aksessuary/"],
  },
];

export const twoMoodMarketplaceAdapter = createPublicHtmlCatalogAdapter({
  provider: "2mood",
  displayName: "2MOOD",
  readConfig: (config) => config.market.twoMood,
  buildSearchUrls: buildTwoMoodSearchUrls,
  productLinkPattern: /\/collection\/katalog\/[^?\s"'<>\\]+\/?/i,
  productPathSegment: "katalog",
  extractProductId: (productUrl) =>
    productUrl.match(/\/collection\/katalog\/([^/?#]+)\/?/i)?.[1],
  referer: "https://www.2moodstore.com/",
});

function buildTwoMoodSearchUrls(
  params: PublicHtmlCatalogSearchUrlParams,
): string[] {
  const paths = resolveTwoMoodCategoryPaths(
    `${params.query} ${params.selection.category ?? ""}`,
  );

  return paths.map((path) =>
    buildPagedUrl(path, params.page, params.marketConfig.publicProductBaseUrl),
  );
}

function resolveTwoMoodCategoryPaths(value: string): string[] {
  const paths: string[] = [];

  for (const route of twoMoodCategoryRoutes) {
    if (route.pattern.test(value)) {
      paths.push(...route.paths);
    }
  }

  paths.push("/collection/katalog/");

  return [...new Set(paths)];
}

function buildPagedUrl(path: string, page: number, baseUrl: string): string {
  const url = new URL(path, baseUrl);

  if (page > 1) {
    url.searchParams.set("page", String(page));
  }

  return url.toString();
}
