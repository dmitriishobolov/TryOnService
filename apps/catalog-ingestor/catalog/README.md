# Catalog Pipeline

`catalog` содержит общий pipeline наполнения каталога одежды.

- `types.ts` - контракт `CatalogGarmentDraft`, `CatalogProvider` и список известных provider-ов.
- `providers/` - место для реализаций сбора данных из магазинов. Сейчас все provider-ы являются no-op заглушками.
- `syncRunner.ts` - периодический запуск provider-ов, защита от наложения циклов и публикация результатов.
- `storagePublisher.ts` - общий writer: скачивает или принимает clean image, загружает его в storage-node и создает `garment-item` catalog entry.

Будущий parser provider должен заниматься только добычей и нормализацией данных магазина. Он не должен знать, как устроены coordinator, storage tokens или формат HTTP upload-а в storage-node.