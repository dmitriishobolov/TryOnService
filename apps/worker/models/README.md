# Worker Models

`models` содержит реализации вызовов к AI API. Каждый provider закрыт adapter-ом, поэтому runner работает с единым интерфейсом и не зависит от деталей конкретного внешнего API.

Выбор provider-а задается клиентом в `CreateTryOnJobRequest.payload.model.provider`. Coordinator использует это поле для matchmaking по capability `try-on.<provider>`, а worker выбирает adapter уже при выполнении конкретной job.

- `mock` - локальная проверка цепочки coordinator assignment -> direct client dispatch -> worker -> client callback.
- `pruna` - Pruna P-Image-Try-On: worker скачивает входные файлы из storage, загружает их в Pruna `/v1/files`, запускает `/v1/predictions` и сохраняет result URL обратно в storage.
- `pixelcut` - Pixelcut Try-On API: worker отправляет `person_image_url` и `garment_image_url`, поэтому входные `StorageObjectRef.url` должны быть публично доступны внешнему API.
- `tryoncloud` - TryOnCloud Developer API или Platform API. `developer` отправляет файлы и получает raw PNG, `platform` отправляет `user_image` + публичный `product_image_url`.
- `genlook` - Genlook Try-On API: worker загружает person image, создает generation и polling-ом ждет результат. Auth header и paths вынесены в env.
- `wearfits` - WEARFITS Virtual Try-On API: worker отправляет sync submit на `/api/v1/virtual-fitting`, затем polling-ом ждет job result.
- `openai` - OpenAI/ChatGPT vision adapter: worker отправляет фото пользователя в Responses API как data URL и возвращает текстовый анализ внешности/гардероба.

Для virtual try-on provider-ов worker ожидает минимум два `payload.inputFiles`: `TRYON_PERSON_IMAGE_INDEX` указывает фото пользователя, `TRYON_GARMENT_IMAGE_INDEX` - фото одежды/товара. OpenAI adapter использует только person image. Результат генеративных provider-ов сохраняется напрямую в object storage под `jobs/<jobId>/results/...`; coordinator получает только `StorageObjectRef` в `TryOnJobResult.files`.

## Структура

- `index.ts` - registry/router adapters; runner импортирует только его.
- `types.ts` - общий контракт `TryOnModelAdapter` и входные типы runner -> model.
- `providerUtils.ts` - общие helper-ы: storage download/upload, multipart helpers, error mapping, URL/id parsing.
- `mock/` - локальная mock-модель для devtest и smoke-проверок.
- `pruna/` - adapter Pruna P-Image-Try-On.
- `pixelcut/` - adapter Pixelcut Try-On API.
- `tryoncloud/` - adapter TryOnCloud Developer/Platform API.
- `genlook/` - adapter Genlook Try-On API.
- `wearfits/` - adapter WEARFITS Virtual Try-On API.
- `openai/` - adapter OpenAI Responses API для vision analysis и wardrobe-рекомендаций.

## Что здесь размещать

- clients для внешних AI API внутри папки соответствующего provider-а;
- adapters под конкретные модели примерки внутри папки соответствующего provider-а;
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

Runner выбирает adapter через `payload.model.provider`. Worker регистрирует capabilities `try-on`, `try-on.mock` и `try-on.<provider>` для provider-ов с настроенными ключами.
