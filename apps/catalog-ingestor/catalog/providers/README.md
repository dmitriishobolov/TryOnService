# Catalog Providers

Здесь будут лежать реализации парсеров магазинов. Сейчас подключены no-op заглушки для архитектуры:

- `wildberries`
- `ozon`
- `aliexpress`
- `tsum`
- `tsum-outlet`
- `ostin`
- `2mood`
- `lime`

Каждый provider должен реализовать `CatalogProvider.collect()` и вернуть массив `CatalogGarmentDraft`. Общий sync runner ограничит batch, а `storagePublisher` загрузит изображение и создаст `garment-item`.

Provider не должен писать в storage напрямую и не должен вызывать coordinator напрямую.