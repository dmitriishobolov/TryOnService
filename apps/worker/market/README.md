# Worker Market

`market` содержит adapters к marketplace-провайдерам, через которые worker может подобрать товары одежды по текстовому описанию и вернуть ссылки на карточки и выставочные фото.

Какие провайдеры требуют credentials для `.env`, описано в [API_KEYS.md](API_KEYS.md).

Поиск не запускается сам по себе. Клиент должен передать `payload.market` в job:

```json
{
  "payload": {
    "command": "request",
    "text": "черная кожаная куртка прямого кроя",
    "market": {
      "query": "черная кожаная куртка прямого кроя",
      "providers": ["aliexpress", "ozon", "wildberries", "tsum", "tsum-outlet", "ostin"],
      "limit": 6,
      "required": false
    }
  }
}
```

Worker выполнит поиск перед AI-моделью, добавит найденные товары в `TryOnJobResult.marketProducts` и продублирует короткую подборку в `message`, чтобы Telegram-клиент уже мог показать пользователю ссылки.

Перед live-поиском worker проверяет общий storage catalog, если `MARKET_STORAGE_CACHE_ENABLED=true`. Cache key строится из параметров `payload.market`, а найденный JSON `market-search` может лежать на любом зарегистрированном storage-node. После успешного поиска worker сохраняет результат в `workers/<workerId>/market-cache/...` и регистрирует:

- `market-search` - JSON со списком найденных товаров по конкретному запросу;
- `market-product` - metadata по отдельным `productUrl`, чтобы coordinator мог ответить, где уже есть информация по конкретной карточке товара.

## Провайдеры

- `aliexpress` - AliExpress Open Platform / Affiliate product query. Требует `ALIEXPRESS_APP_KEY` и `ALIEXPRESS_APP_SECRET`; при наличии tracking/app signature worker добавит их в запрос.
- `ozon` - public page parser. Adapter открывает HTML поиска Ozon, извлекает ссылки `/product/`, затем читает карточки товара из HTML/JSON-LD/meta и нормализует `title`, `price`, `imageUrl`.
- `wildberries` - public catalog parser. Adapter читает публичную JSON-выдачу `search.wb.ru` по `query` и нормализует товары всей площадки.
- `tsum` - public HTML catalog parser для `www.tsum.ru`. Adapter открывает search/catalog HTML, извлекает JSON-LD `ItemList/Product`, ссылки `/product/...`, затем читает карточки товара и фото.
- `tsum-outlet` - public HTML catalog parser для `outlet.tsum.ru` с тем же контрактом, но отдельным кешем, cooldown и env-настройками.
- `ostin` - public HTML catalog parser для `ostin.com`. Adapter поддерживает URL товаров вида `/product/<slug>/<id>`, читает JSON-LD/meta и умеет корректно уйти в cooldown, если сайт вернул QRator/captcha/challenge.

Важно: public parsers не используют stealth, proxy rotation или captcha bypass. Если сайт возвращает redirect-loop/anti-bot/challenge вместо HTML, adapter включает cooldown и stale-cache fallback, если такой cache уже есть.

## Структура

- `index.ts` - registry adapters и общий `searchMarketplaceProducts`.
- `types.ts` - интерфейсы `MarketplaceAdapter`, `MarketplaceSearchInput`, `MarketplaceSearchResult`.
- `storageCache.ts` - общий storage-cache marketplace search/product metadata через coordinator catalog lookup.
- `utils.ts` - HTTP, нормализация цен, ссылок и поиск по тексту.
- `aliexpress/` - реализация AliExpress Affiliate API.
- `ozon/` - реализация Ozon public page parser.
- `publicHtmlCatalog.ts` - общий HTML/JSON-LD parser для каталогов с `/product/...` ссылками, кешем, in-flight склейкой и cooldown.
- `tsum/` - реализация TSUM public catalog parser.
- `tsumOutlet/` - реализация TSUM Outlet public catalog parser.
- `ostin/` - реализация O'STIN public catalog parser.
- `wildberries/` - реализация Wildberries public catalog parser.

## Контракт

`payload.market` поддерживает:

- `query` - описание одежды для поиска. Если пусто, worker использует `payload.text`.
- `providers` - список `aliexpress`, `ozon`, `wildberries`, `tsum`, `tsum-outlet`, `ostin`; если не передан, используется `MARKET_PROVIDERS`.
- `limit` - общий лимит товаров в результате, максимум 100.
- `category`, `categoryIds`, `minPrice`, `maxPrice`, `currency`, `locale`, `country`, `sort` - дополнительные фильтры, если provider поддерживает их напрямую или через локальную фильтрацию.
- `required` - если `true`, ошибка marketplace-поиска фейлит job; если `false`, worker логирует ошибку и продолжает AI-обработку.

## Capabilities

Worker автоматически объявляет:

- `market.aliexpress`, если заполнены `ALIEXPRESS_APP_KEY` и `ALIEXPRESS_APP_SECRET`;
- `market.ozon`, если `MARKET_PROVIDERS` включает `ozon`;
- `market.wildberries`, если `MARKET_PROVIDERS` включает `wildberries`;
- `market.tsum`, если `MARKET_PROVIDERS` включает `tsum`;
- `market.tsum-outlet`, если `MARKET_PROVIDERS` включает `tsum-outlet`;
- `market.ostin`, если `MARKET_PROVIDERS` включает `ostin`;
- `market`, если доступен хотя бы один marketplace provider.

## Public parsing

Public parsers сделаны как обычный lookup по публичным страницам/JSON, а не как обход защиты сайта:

- Wildberries делает один JSON GET к `search.wb.ru/exactmatch/.../search` с `query`, `dest`, `curr=rub`, `sort` и `page=1`;
- Ozon делает HTML GET к странице поиска, извлекает ссылки на товары и читает ограниченное число карточек;
- TSUM, TSUM Outlet и O'STIN используют общий HTML catalog parser: открывают search/catalog страницу, извлекают JSON-LD `ItemList/Product`, ссылки `/product/...`, meta-теги и изображения, затем ограниченно открывают карточки товаров;
- использует обычные browser-like `Accept`, `Accept-Language`, `Referer` и `User-Agent`;
- не использует captcha bypass, proxy rotation, stealth browser automation или авторизацию пользователя;
- не ходит бесконечно по страницам: WB берёт первую страницу, HTML parsers ограничены `*_PUBLIC_SEARCH_PAGES` и `*_MAX_SCAN_PRODUCTS`;
- кеширует выдачу в памяти worker-а: fresh-cache отвечает без внешнего запроса, stale-cache используется как fallback при `429`/ошибках, параллельные одинаковые запросы склеиваются в один in-flight request;
- дополнительно пишет successful search в object storage catalog как shared cache между worker'ами/storage-node;
- WB image URL строятся по `nmId` через CDN `basket-XX.wbbasket.ru`, если поисковый JSON не вернул готовые изображения.

## Добавление нового marketplace provider-а

1. Добавьте имя provider-а в `MarketProvider` и validator `isMarketProvider` в [contracts](../../shared/contracts/index.ts). Если provider требует новые общие фильтры, расширьте `MarketSearchSelection` и `isMarketSearchSelection`.
2. Создайте папку `apps/worker/market/<provider>/index.ts`. Adapter должен реализовать `MarketplaceAdapter`: `provider`, `displayName`, `isConfigured(config)` и `search(input)`.
3. Подключите adapter в [market/index.ts](index.ts): импортируйте его и добавьте в массив `adapters`.
4. Добавьте provider-specific config в [worker config](../config/index.ts): interface, чтение env в `loadWorkerConfig`, defaults и валидацию.
5. Добавьте автоматическую capability в `readCapabilities()` через `syncMarketCapability` для credential-based provider-а или `syncPublicMarketCapability` для public parser-а. Для provider-а должна появляться capability `market.<provider>`, а общая capability `market` должна появляться, если доступен хотя бы один marketplace provider.
6. Добавьте provider в `MARKET_PROVIDERS` default, если он должен участвовать в поиске по умолчанию.
7. Добавьте env-параметры в [.env.example](../../../.env.example) отдельным блоком `Worker marketplace provider: <Provider>`. Секреты оставляйте пустыми.
8. Добавьте эти env keys в `worker.envKeys` в [scripts/build-dist.mjs](../../../scripts/build-dist.mjs) и в env whitelist [scripts/devtest.mjs](../../../scripts/devtest.mjs), чтобы deploy/devtest пакеты получали настройки.
9. В adapter-е нормализуйте ответ внешнего API к `MarketProductRef`: обязательны `provider`, `productId`, `title`; желательны `productUrl`, `imageUrl`/`images`, `price`, `brand`, `category`.
10. Не скачивайте выставочные фото в worker без необходимости. Для TryOn pipeline достаточно вернуть публичный `imageUrl` или сохранить файл отдельным шагом, если будущий сценарий явно потребует локальный `StorageObjectRef`.
11. Ошибки внешнего API приводите к `MarketplaceError` с понятным `code` и `retryable`. Для HTTP JSON используйте helpers из [utils.ts](utils.ts): `fetchMarketJson`, `marketplaceResponseError`, `requireMarketCredential`.
12. Обновите этот README, [worker config README](../config/README.md), [client guide](../../client/NEW_CLIENT_GUIDE.md) и, если меняется публичный payload/result, [contracts README](../../shared/contracts/README.md).
13. Проверьте `npm run typecheck`, `npm run build:dist` и `npm run build:devtest`.

Минимальный каркас adapter-а:

```ts
import type { MarketplaceAdapter } from "../types.js";
import { requireMarketCredential } from "../utils.js";

const provider = "<provider>";

export const myMarketplaceAdapter: MarketplaceAdapter = {
  provider,
  displayName: "My Marketplace",
  isConfigured: (config) => Boolean(config.market.myMarketplace.apiKey),
  search: async ({ query, selection, config, signal }) => {
    const apiKey = requireMarketCredential(
      provider,
      "MY_MARKETPLACE_API_KEY",
      config.market.myMarketplace.apiKey,
    );

    // 1. Вызвать внешний API.
    // 2. Отфильтровать результат по query/price/category, если provider не делает это сам.
    // 3. Вернуть MarketplaceSearchResult с нормализованными MarketProductRef.

    return {
      provider,
      products: [],
    };
  },
};
```

Если новый источник похож на TSUM/O'STIN и отдает обычные HTML-каталоги с `application/ld+json`, meta-тегами или ссылками `/product/...`, используйте общий helper `createPublicHtmlCatalogAdapter` из [publicHtmlCatalog.ts](publicHtmlCatalog.ts). В этом случае provider-specific папка обычно содержит только `provider`, `displayName`, `readConfig`, `productLinkPattern`, `extractProductId` и `referer`, а кеш, throttle, cooldown, JSON-LD/meta parsing и нормализация товара остаются общими.
