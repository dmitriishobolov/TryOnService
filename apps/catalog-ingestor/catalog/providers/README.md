# Catalog Providers

Здесь лежат реализации источников каталога. Provider отвечает только за добычу и нормализацию данных магазина. Общий sync runner вызывает `CatalogProvider.collect()`, ограничивает batch, а `storagePublisher` загружает clean image и создает `garment-item` в storage.

Сейчас подключены архитектурные no-op заглушки для будущих парсеров:

- `wildberries`
- `ozon`
- `aliexpress`
- `tsum`
- `tsum-outlet`
- `ostin`
- `2mood`
- `lime`

Дополнительно есть рабочая заготовка [custom](custom/README.md). Она умеет читать нормализованные товары из JSON-файла и служит местом для вашего кастомного parser-а.

## Контракт provider-а

Provider должен реализовать `CatalogProvider.collect(context)` и вернуть массив `CatalogGarmentDraft`:

- `provider` - имя provider-а;
- `externalId` - стабильный id товара;
- `productUrl` - ссылка на карточку товара;
- `title` - название;
- `category` - роль вещи в образе;
- `image.url` или `image.data` - clean front-view изображение.

Желательные поля: `description`, `tags`, `colorTags`, `styleTags`, `materialTags`, `price`, `currency`, `store`, `metadata`.

Provider не должен писать в storage напрямую и не должен вызывать coordinator напрямую. Это важно, чтобы все provider-ы одинаково проходили storage-access, keyPrefix ownership, лимиты размера изображений и единый формат catalog entry.
