# Worker Market

`market` содержит adapters к marketplace API, через которые worker может подобрать товары одежды по текстовому описанию и вернуть ссылки на карточки и выставочные фото.

Поиск не запускается сам по себе. Клиент должен передать `payload.market` в job:

```json
{
  "payload": {
    "command": "request",
    "text": "черная кожаная куртка прямого кроя",
    "market": {
      "query": "черная кожаная куртка прямого кроя",
      "providers": ["aliexpress", "ozon", "wildberries"],
      "limit": 6,
      "required": false
    }
  }
}
```

Worker выполнит поиск перед AI-моделью, добавит найденные товары в `TryOnJobResult.marketProducts` и продублирует короткую подборку в `message`, чтобы Telegram-клиент уже мог показать пользователю ссылки.

## Провайдеры

- `aliexpress` - AliExpress Open Platform / Affiliate product query. Требует `ALIEXPRESS_APP_KEY` и `ALIEXPRESS_APP_SECRET`; при наличии tracking/app signature worker добавит их в запрос.
- `ozon` - Ozon Seller API. Adapter получает список товаров продавца, запрашивает подробности и фильтрует доступный seller-каталог по `query`.
- `wildberries` - Wildberries Content API. Adapter читает карточки продавца с фото и фильтрует доступный seller-каталог по `query`.

Важно: `ozon` и `wildberries` используют seller API, поэтому они не являются глобальным поиском по всему marketplace. Они ищут среди товаров, доступных аккаунту/токену.

## Структура

- `index.ts` - registry adapters и общий `searchMarketplaceProducts`.
- `types.ts` - интерфейсы `MarketplaceAdapter`, `MarketplaceSearchInput`, `MarketplaceSearchResult`.
- `utils.ts` - HTTP, нормализация цен, ссылок и поиск по тексту.
- `aliexpress/` - реализация AliExpress Affiliate API.
- `ozon/` - реализация Ozon Seller API.
- `wildberries/` - реализация Wildberries Content API.

## Контракт

`payload.market` поддерживает:

- `query` - описание одежды для поиска. Если пусто, worker использует `payload.text`.
- `providers` - список `aliexpress`, `ozon`, `wildberries`; если не передан, используется `MARKET_PROVIDERS`.
- `limit` - общий лимит товаров в результате, максимум 100.
- `category`, `categoryIds`, `minPrice`, `maxPrice`, `currency`, `locale`, `country`, `sort` - дополнительные фильтры, если provider поддерживает их напрямую или через локальную фильтрацию.
- `required` - если `true`, ошибка marketplace-поиска фейлит job; если `false`, worker логирует ошибку и продолжает AI-обработку.

## Capabilities

Worker автоматически объявляет:

- `market.aliexpress`, если заполнены `ALIEXPRESS_APP_KEY` и `ALIEXPRESS_APP_SECRET`;
- `market.ozon`, если заполнены `OZON_CLIENT_ID` и `OZON_API_KEY`;
- `market.wildberries`, если заполнен `WILDBERRIES_API_KEY`;
- `market`, если доступен хотя бы один marketplace provider.

## Добавление нового marketplace provider-а

1. Добавьте имя provider-а в `MarketProvider` и validator `isMarketProvider` в [contracts](../../shared/contracts/index.ts). Если provider требует новые общие фильтры, расширьте `MarketSearchSelection` и `isMarketSearchSelection`.
2. Создайте папку `apps/worker/market/<provider>/index.ts`. Adapter должен реализовать `MarketplaceAdapter`: `provider`, `displayName`, `isConfigured(config)` и `search(input)`.
3. Подключите adapter в [market/index.ts](index.ts): импортируйте его и добавьте в массив `adapters`.
4. Добавьте provider-specific config в [worker config](../config/index.ts): interface, чтение env в `loadWorkerConfig`, defaults и валидацию.
5. Добавьте автоматическую capability в `readCapabilities()` через `syncMarketCapability`. Для provider-а должна появляться capability `market.<provider>`, а общая capability `market` должна появляться, если доступен хотя бы один marketplace provider.
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
