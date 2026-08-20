# Worker Models

`models` содержит реализации вызовов к AI API. Каждый provider закрыт adapter-ом, поэтому runner работает с единым интерфейсом и не зависит от деталей конкретного внешнего API.

Выбор provider-а задается через `TRYON_MODEL_PROVIDER`:

- `mock` - локальная проверка цепочки coordinator assignment -> direct client dispatch -> worker -> client callback.
- `pruna` - Pruna P-Image-Try-On: worker скачивает входные файлы из storage, загружает их в Pruna `/v1/files`, запускает `/v1/predictions` и сохраняет result URL обратно в storage.
- `pixelcut` - Pixelcut Try-On API: worker отправляет `person_image_url` и `garment_image_url`, поэтому входные `StorageObjectRef.url` должны быть публично доступны внешнему API.
- `tryoncloud` - TryOnCloud Developer API или Platform API. `developer` отправляет файлы и получает raw PNG, `platform` отправляет `user_image` + публичный `product_image_url`.
- `genlook` - Genlook Try-On API: worker загружает person image, создает generation и polling-ом ждет результат. Auth header и paths вынесены в env.
- `wearfits` - WEARFITS Virtual Try-On API: worker отправляет sync submit на `/api/v1/virtual-fitting`, затем polling-ом ждет job result.

Для реальных provider-ов worker ожидает минимум два `payload.inputFiles`: `TRYON_PERSON_IMAGE_INDEX` указывает фото пользователя, `TRYON_GARMENT_IMAGE_INDEX` - фото одежды/товара. Результат каждого provider-а сохраняется напрямую в object storage под `jobs/<jobId>/results/...`; coordinator получает только `StorageObjectRef` в `TryOnJobResult.files`.

## Что здесь размещать

- clients для внешних AI API;
- adapters под конкретные модели примерки;
- нормализацию запросов и ответов provider'а;
- обработку provider-specific ошибок;
- retry/timeout policy, если она относится именно к вызову модели.

## Что не размещать

- маршруты coordinator;
- бизнес-пайплайн обработки клиента;
- хранение job state;
- UI или клиентские интеграции.

## Рекомендуемый контракт adapter'а

Каждый adapter должен явно описывать:

- какие входные данные принимает;
- какие capabilities предоставляет;
- какой результат возвращает;
- какие ошибки являются retryable;
- какие лимиты есть у provider'а.

Runner выбирает adapter через `TRYON_MODEL_PROVIDER`. Для будущего тонкого routing-а worker регистрирует capabilities `try-on` и `try-on.<provider>`, а coordinator сейчас требует общий `try-on`.
