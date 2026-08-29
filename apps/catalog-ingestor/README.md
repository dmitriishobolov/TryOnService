# Catalog Ingestor

`apps/catalog-ingestor` - отдельный сервис сбора каталога одежды. Его можно положить на любую машину с доступом к coordinator и интернету: сервис регистрируется как service client, отправляет heartbeat, получает прямой доступ к object storage и публикует записи `garment-item`.

Сейчас реализована архитектура без реального парсинга сайтов. Провайдеры `wildberries`, `ozon`, `aliexpress`, `tsum`, `tsum-outlet`, `ostin`, `2mood` и `lime` подключены как no-op заглушки. Provider `custom` уже готов как основа под ваш parser: он умеет читать нормализованные товары из JSON-файла, а его `parser.ts` можно заменить на реальный обход нужного источника.

## Запуск

```bash
npm run dev:catalog-ingestor
```

По умолчанию sync выключен через `CATALOG_INGESTOR_ENABLED=false`. Сервис всё равно поднимает health endpoint, регистрируется в coordinator и отправляет heartbeat, чтобы можно было проверять deploy/lifecycle.

Перед browser-парсингом на новой машине один раз установите Chromium:

```bash
npm run playwright:install
```

Для проверки чтения страницы через Playwright включите sync и укажите URL:

```env
CATALOG_INGESTOR_ENABLED=true
CATALOG_INGESTOR_PROVIDERS=custom
CATALOG_INGESTOR_CUSTOM_URL=https://example.com/catalog
```

Пока JSON-файл не задан, custom provider прочитает страницу, выведет snapshot в лог и вернет пустой список товаров. Это удобно для ручной разработки parser-а.

Для проверки custom provider-а через готовый JSON включите sync и укажите файл с товарами:

```env
CATALOG_INGESTOR_ENABLED=true
CATALOG_INGESTOR_PROVIDERS=custom
CATALOG_INGESTOR_CUSTOM_SOURCE_FILE=apps/catalog-ingestor/catalog/providers/custom/example-catalog.json
```

## Поток данных

1. Catalog ingestor стартует, выбирает свободный порт и регистрируется в coordinator через `POST /clients/register` с типом `catalog-ingestor`.
2. Scheduler запускает provider-ы из `CATALOG_INGESTOR_PROVIDERS`.
3. Provider возвращает `CatalogGarmentDraft`: ссылка на товар, category, title, tags, price/store и источник clean image.
4. Publisher запрашивает `POST /storage/access` с prefix внутри `clients/<CATALOG_INGESTOR_CLIENT_ID>/catalog`.
5. Publisher загружает изображение напрямую в выбранный storage-node через `PUT /objects/<key>`.
6. Publisher вызывает storage-node `POST /catalog/entries` и создает запись `kind=garment-item`.
7. Worker сценария `ideal-outfit` потом читает эти категории и вещи через coordinator, не обращаясь к ingestor.

## Подпапки

- `api` - registration/heartbeat client к coordinator и маленький health/callback server.
- `config` - env-настройки сервиса.
- `browser` - базовый Playwright helper для чтения страниц по URL.
- `catalog` - контракты provider-ов, sync runner и общий publisher в storage.
- `catalog/providers` - место для будущих реализаций парсинга каталогов.
- `catalog/providers/custom` - основа для вашего кастомного parser-а и пример входного JSON.

## Как добавить свой parser

Быстрый путь:

1. Откройте `catalog/providers/custom/parser.ts`.
2. В `collectCustomCatalog(context)` получите данные из своего источника: HTML, локальный файл, API, выгрузка магазина.
3. Приведите каждую найденную вещь к `CatalogGarmentDraft`.
4. Верните массив draft-ов. Запись в storage делать не нужно.
5. В `.env` поставьте `CATALOG_INGESTOR_PROVIDERS=custom` и `CATALOG_INGESTOR_ENABLED=true`.

Если источник станет постоянным provider-ом, создайте отдельную папку в `catalog/providers/<provider-name>`, реализуйте `CatalogProvider`, добавьте имя в `catalogProviderNames` и подключите его в `catalog/providers/index.ts`.

## Формат нормализованной вещи

Provider должен вернуть минимум:

- `provider` - имя источника из списка provider-ов, для custom parser-а это `custom`.
- `externalId` - стабильный id товара в магазине.
- `productUrl` - ссылка на страницу товара.
- `title` и `category` - название и роль вещи.
- `image` - clean front-view изображение вещи: URL или bytes.

Желательные поля: `description`, `tags`, `colorTags`, `styleTags`, `materialTags`, `price`, `currency`, `store`, `metadata`, `cacheKey`.

Подробный формат JSON, TypeScript-пример и правила качества изображений описаны в [custom provider README](catalog/providers/custom/README.md).

## Что будет записано

На каждую вещь `storagePublisher` создает:

- object с изображением по ключу вида `clients/<clientId>/catalog/<provider>/<category>/<cacheKey>/<filename>`;
- catalog entry `kind=garment-item` с `cacheKey`, `objectKey` и metadata товара.

Metadata включает `provider`, `externalId`, `productUrl`, `title`, `category`, `description`, `tags`, `colorTags`, `styleTags`, `materialTags`, `price`, `currency`, `store` и дополнительные поля из `metadata`.

## Правила

- Ingestor не должен создавать пользовательские jobs и не должен вызывать AI TryOn.
- Coordinator остаётся control-plane: выбирает storage и подписывает token, но не принимает картинки через себя.
- Все тяжелые изображения идут напрямую в storage-node.
- Storage prefix по умолчанию ограничен namespace service client-а: `clients/<clientId>/catalog`.
- Реальный парсер сайта должен быть изолирован в своей provider-папке, чтобы общий sync/publish pipeline не зависел от HTML/API конкретного магазина.
