# Catalog Layer

Папка `catalog` содержит общий pipeline наполнения каталога вещей:

- `types.ts` - контракт `CatalogGarmentDraft`, `CatalogProvider` и список известных provider-ов.
- `providers` - реализации источников каталога и заготовка `custom` для вашего parser-а.
- `syncRunner.ts` - периодический запуск provider-ов и публикация batch-а.
- `storagePublisher.ts` - общий writer: скачивает или принимает clean image, загружает его в storage-node и создает `garment-item` catalog entry.

Будущий parser provider должен заниматься только добычей и нормализацией данных магазина. Он не должен знать, как устроены coordinator, storage tokens или формат HTTP upload-а в storage-node.

Если нужно быстро наполнить каталог вручную или проверить формат без настоящего парсинга сайта, используйте provider [custom](providers/custom/README.md) и `CATALOG_INGESTOR_CUSTOM_SOURCE_FILE`.
