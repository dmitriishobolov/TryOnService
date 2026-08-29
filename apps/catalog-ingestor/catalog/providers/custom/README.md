# Custom Catalog Provider

`custom` - заготовка под ваш собственный парсер каталога. Он нужен, чтобы быстро подключить любой источник товаров без переписывания общего pipeline catalog ingestor.

Provider должен только собрать и вернуть нормализованные вещи. Он не регистрируется в coordinator, не получает storage token и не пишет файлы сам. Это делает общий `GarmentCatalogPublisher`.

## Быстрый старт через Playwright URL

Если нужно просто проверить, что parser умеет открыть страницу, укажите URL:

```env
CATALOG_INGESTOR_ENABLED=true
CATALOG_INGESTOR_PROVIDERS=custom
CATALOG_INGESTOR_CUSTOM_URL=https://example.com/catalog
CATALOG_INGESTOR_BROWSER_HEADLESS=true
CATALOG_INGESTOR_BROWSER_WAIT_UNTIL=domcontentloaded
```

В таком режиме `custom/parser.ts` откроет страницу через Playwright, прочитает title, final URL, status, HTML, body text и первые ссылки, выведет краткий snapshot в лог и вернет пустой список товаров. Это специально сделано как чистая основа: вы сами будете превращать `page.html`, `page.text` или `page.links` в `CatalogGarmentDraft[]`.

Перед первым запуском browser-парсера на новой машине установите Chromium:

```bash
npm run playwright:install
```

## Быстрый старт через JSON

Для первой проверки можно не писать код парсинга, а отдать товары из JSON-файла:

```env
CATALOG_INGESTOR_ENABLED=true
CATALOG_INGESTOR_PROVIDERS=custom
CATALOG_INGESTOR_CUSTOM_SOURCE_FILE=apps/catalog-ingestor/catalog/providers/custom/example-catalog.json
```

После старта `npm run dev:catalog-ingestor` сервис прочитает файл, возьмет не больше `CATALOG_INGESTOR_BATCH_SIZE` записей, загрузит изображения в storage-node и создаст catalog entries `kind=garment-item`. Относительные `image.path` считаются от текущей рабочей папки процесса.

Файл может быть массивом объектов или объектом с полем `items`:

```json
{
  "items": [
    {
      "externalId": "shop-shirt-1001",
      "productUrl": "https://example.com/product/shop-shirt-1001",
      "title": "Белая рубашка прямого кроя",
      "category": "рубашка",
      "description": "Плотный хлопок, спокойный smart casual.",
      "tags": ["мужское", "smart casual", "прямой крой"],
      "colorTags": ["белый", "светлый"],
      "styleTags": ["минимализм", "офис"],
      "materialTags": ["хлопок"],
      "price": "4990",
      "currency": "RUB",
      "store": "Example Store",
      "image": {
        "path": "apps/catalog-ingestor/catalog/providers/custom/example-shirt.svg",
        "contentType": "image/svg+xml",
        "filename": "demo-white-shirt-front.svg"
      },
      "metadata": {
        "gender": "men",
        "season": "all-season"
      }
    }
  ]
}
```

Вместо `image.url` можно передать локальный файл:

```json
{
  "externalId": "local-jeans-1002",
  "productUrl": "https://example.com/product/local-jeans-1002",
  "title": "Прямые темно-синие джинсы",
  "category": "джинсы",
  "image": {
    "path": "D:/catalog-images/local-jeans-1002.png",
    "contentType": "image/png",
    "filename": "local-jeans-1002.png"
  }
}
```

Также поддерживаются плоские поля `imageUrl`, `imagePath`, `imageContentType`, `imageFilename`.

## Как писать свой parser.ts

Основная точка расширения - `parser.ts`:

```ts
export async function collectCustomCatalog(
  context: CatalogProviderContext,
): Promise<CatalogGarmentDraft[]> {
  // 1. Получите страницу, файл, API-ответ или локальный dataset.
  //    Для браузерной страницы используйте readCatalogPage().
  // 2. Нормализуйте каждую вещь в CatalogGarmentDraft.
  // 3. Верните массив. Запись в storage сделает общий publisher.
}
```

`context` содержит:

- `batchSize` - сколько товаров максимум стоит вернуть за цикл;
- `userAgent` - User-Agent для HTTP-запросов вашего парсера;
- `customSourceFile` - путь из `CATALOG_INGESTOR_CUSTOM_SOURCE_FILE`, если вы используете JSON/dataset;
- `customUrl` - URL из `CATALOG_INGESTOR_CUSTOM_URL` для Playwright-чтения страницы;
- `browserHeadless` - запускать Chromium без окна;
- `browserTimeoutMs` - timeout открытия страницы;
- `browserWaitUntil` - `load`, `domcontentloaded` или `networkidle`;
- `browserTextMaxChars` - сколько символов body text вернуть в snapshot;
- `browserLinksMaxCount` - сколько ссылок вернуть в snapshot;
- `signal` - reserved AbortSignal для будущей отмены долгих обходов.

Минимальный `CatalogGarmentDraft`:

```ts
{
  provider: "custom",
  externalId: "stable-product-id",
  productUrl: "https://shop.example/product/123",
  title: "Название товара",
  category: "рубашка",
  image: {
    url: "https://shop.example/images/123-front.jpg"
  }
}
```

Обязательные поля:

- `provider` - для этой заготовки всегда `custom`;
- `externalId` - стабильный id товара внутри источника;
- `productUrl` - ссылка на карточку товара, которую клиент покажет пользователю;
- `title` - человекочитаемое название;
- `category` - роль вещи в образе;
- `image.url` или `image.data` - чистое front-view изображение вещи.

Желательные поля:

- `description` - короткое описание товара;
- `tags` - общие признаки для поиска и выбора;
- `colorTags` - цвета: `белый`, `графитовый`, `оливковый`;
- `styleTags` - стиль: `casual`, `smart casual`, `минимализм`;
- `materialTags` - материал: `хлопок`, `деним`, `шерсть`;
- `price`, `currency`, `store` - данные для карточки в клиенте;
- `metadata` - любые дополнительные поля, например `gender`, `season`, `brand`, `sizes`, `marketplace`;
- `cacheKey` - опциональный стабильный ключ, если вы хотите сами управлять переиспользованием записи.

## Как это записывается в storage

Для каждого draft общий publisher делает три операции:

1. Запрашивает у coordinator `POST /storage/access` с `scope=read-write` и prefix внутри `clients/<CATALOG_INGESTOR_CLIENT_ID>/catalog`.
2. Загружает изображение в выбранный storage-node через `PUT /objects/<key>`.
3. Создает запись `POST /catalog/entries`:

```json
{
  "entry": {
    "cacheKey": "garment:custom:stable-product-id:hash",
    "kind": "garment-item",
    "objectKey": "clients/catalog-ingestor-1/catalog/custom/рубашка/.../image.jpg",
    "metadata": {
      "provider": "custom",
      "externalId": "stable-product-id",
      "productUrl": "https://shop.example/product/123",
      "title": "Название товара",
      "category": "рубашка",
      "tags": ["casual"],
      "price": "4990",
      "currency": "RUB",
      "store": "Example Store"
    }
  }
}
```

Coordinator потом читает эти записи через storage catalog endpoints, а worker сценария `ideal-outfit` выбирает вещи по `category`, `tags`, `colorTags`, `styleTags`, `materialTags` и тексту.

## Правила качества данных

- Изображение должно быть вещью спереди на белом или контрастном фоне.
- Не кладите изображения, где главный объект закрыт человеком, манекеном, руками или другой одеждой.
- Не кладите несколько вещей в одну карточку, если это не комплект, который должен примеряться целиком.
- `category` должна быть простой ролью вещи: `футболка`, `рубашка`, `брюки`, `джинсы`, `куртка`, `худи`, `платье`, `юбка`, `обувь`, `аксессуар`.
- `productUrl` должен вести на реально продающийся товар, а не на страницу поиска или подборки.
- `externalId` должен оставаться одинаковым между sync cycle, иначе catalog будет плодить дубликаты.
