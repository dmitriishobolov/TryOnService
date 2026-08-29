# TSUM Catalog Provider

`providers/tsum` - отдельное место под уникальный parser сайта ЦУМ.

Сейчас parser открывает страницу через Playwright, читает JSON из `__INITIAL_STATE__`, берет товары из `catalogs.list.<catalog-slug>.data.list` и нормализует их в общий формат. Дальше сюда можно добавлять уникальные правила ЦУМа: пагинацию, обход категорий, фильтрацию изображений и дополнительные теги, не трогая `custom` provider и общий storage pipeline.

## Запустить только TSUM parser

Перед первым запуском Playwright на машине:

```bash
npm run playwright:install
```

Потом:

```bash
npm run dev:catalog-parser:tsum
```

URL для ручного запуска меняется в `parser.ts`:

```ts
const DIRECT_RUN_URL = DEFAULT_TSUM_START_URL;
```

По умолчанию стоит каталог одежды:

```text
https://www.tsum.ru/catalog/odezhda-18413/
```

## Запустить через catalog-ingestor service

```env
CATALOG_INGESTOR_ENABLED=true
CATALOG_INGESTOR_PROVIDERS=tsum
CATALOG_INGESTOR_TSUM_START_URL=https://www.tsum.ru/catalog/odezhda-18413/
```

В этом режиме service сам зарегистрируется в coordinator, вызовет TSUM provider, а все `CatalogGarmentDraft`, которые вернет parser, общий `storagePublisher` загрузит в storage как `garment-item`.

## Где писать уникальную логику

Основные места в `parser.ts`:

- `readTsumCatalogPage()` - открывает страницу через Playwright и возвращает `CatalogPageSnapshot`.
- `parseTsumCatalogPage()` - извлекает `__INITIAL_STATE__`, выбирает список товаров текущего каталога и передает их в нормализацию.
- `TsumProductCandidate` - промежуточный формат сырой карточки ЦУМа.
- `normalizeTsumCandidates()` - превращает кандидатов в общий `CatalogGarmentDraft`.

Минимальный candidate, который нужно получить из страницы:

```ts
{
  productUrl: "https://www.tsum.ru/product/...",
  title: "Название товара",
  imageUrl: "https://.../front.jpg"
}
```

Если `externalId` не указан, parser попытается взять его из URL товара или создать стабильный hash. `category` по умолчанию станет `одежда`, `store` - `ЦУМ`, `currency` - `RUB`.
## Что мы увидели в HTML ЦУМ

Каталог одежды отдает SSR/initial-state данные прямо в HTML:

- `script#__INITIAL_STATE__` содержит большой JSON состояния страницы;
- товары первой страницы лежат по пути `catalogs.list.odezhda-18413.data.list`;
- в каждом товаре есть `id`, `ext_id`, `slug`, `title`, `brand_name`, `category_slug`, `colorConcrete`, `photos`, `skuList`, `inStock` и `season`;
- URL товара собирается как `/product/<slug>/`;
- цену берем из `skuList[].price_discount`/`price_original`;
- изображение берем из первого объекта `photos`, сейчас с приоритетом больших размеров `large`, `w1320`, `middle`, `w600`.

Поэтому CSS-селекторы карточек сейчас не основной источник данных. Они могут пригодиться позже как fallback, если ЦУМ поменяет initial state.

## Что вернет parser дальше по pipeline

После нормализации каждая вещь станет `CatalogGarmentDraft`:

```ts
{
  provider: "tsum",
  externalId: "...",
  productUrl: "https://www.tsum.ru/product/...",
  title: "...",
  category: "одежда",
  tags: ["цум", "tsum"],
  currency: "RUB",
  store: "ЦУМ",
  image: { url: "https://..." },
  metadata: { marketplace: "tsum" }
}
```

Storage-запись руками делать не нужно. Provider только возвращает массив, всё остальное делает общий publisher.
