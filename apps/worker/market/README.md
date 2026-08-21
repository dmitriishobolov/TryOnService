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

