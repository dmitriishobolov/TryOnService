# TSUM Catalog Provider

`providers/tsum` - отдельное место под уникальный parser сайта ЦУМ.

Сейчас parser делает только базовое чтение страницы через Playwright и возвращает пустой массив товаров. Это намеренно: дальше сюда можно спокойно писать уникальную логику извлечения карточек ЦУМа, не трогая `custom` provider и общий storage pipeline.

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
- `parseTsumCatalogPage()` - сюда пишем извлечение карточек ЦУМа из `page.html`, `page.text` или `page.links`.
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
