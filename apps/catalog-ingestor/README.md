# Catalog Ingestor

`apps/catalog-ingestor` - отдельный сервис сбора каталога одежды. Его можно положить на любую машину с доступом к coordinator и интернету: сервис регистрируется как service client, отправляет heartbeat, получает прямой доступ к object storage и публикует записи `garment-item`.

Сейчас реализована архитектура без реального парсинга сайтов. Провайдеры `wildberries`, `ozon`, `aliexpress`, `tsum`, `tsum-outlet`, `ostin`, `2mood` и `lime` подключены как no-op заглушки. Когда появится конкретный парсер, он должен вернуть нормализованные `CatalogGarmentDraft`, а общий publisher уже загрузит clean image в storage и создаст catalog entry.

## Запуск

```bash
npm run dev:catalog-ingestor
```

По умолчанию sync выключен через `CATALOG_INGESTOR_ENABLED=false`. Сервис всё равно поднимает health endpoint, регистрируется в coordinator и отправляет heartbeat, чтобы можно было проверять deploy/lifecycle.

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
- `catalog` - контракты provider-ов, sync runner и общий publisher в storage.
- `catalog/providers` - место для будущих реализаций парсинга каталогов.

## Формат нормализованной вещи

Provider должен вернуть минимум:

- `provider` - имя источника из списка provider-ов.
- `externalId` - стабильный id товара в магазине.
- `productUrl` - ссылка на страницу товара.
- `title` и `category` - название и роль вещи.
- `image` - clean front-view изображение вещи: URL или bytes.

Желательные поля: `description`, `tags`, `colorTags`, `styleTags`, `materialTags`, `price`, `currency`, `store`.

## Правила

- Ingestor не должен создавать пользовательские jobs и не должен вызывать AI TryOn.
- Coordinator остаётся control-plane: выбирает storage и подписывает token, но не принимает картинки через себя.
- Все тяжелые изображения идут напрямую в storage-node.
- Storage prefix по умолчанию ограничен namespace service client-а: `clients/<clientId>/catalog`.
- Реальный парсер сайта должен быть изолирован в своей provider-папке, чтобы общий sync/publish pipeline не зависел от HTML/API конкретного магазина.