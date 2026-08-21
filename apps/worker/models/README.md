# Worker Models

`models` содержит реализации вызовов к AI API. Каждый provider закрыт adapter-ом, поэтому runner работает с единым интерфейсом и не зависит от деталей конкретного внешнего API.

Выбор provider-а задается клиентом в `CreateTryOnJobRequest.payload.model.provider`. Конкретную модель provider-а клиент может передать в `payload.model.providerModel`. Coordinator использует provider для matchmaking по capability `try-on.<provider>`, а worker выбирает adapter уже при выполнении конкретной job.

- `mock` - локальная проверка цепочки coordinator assignment -> direct client dispatch -> worker -> client callback.
- `pruna` - Pruna P-Image-Try-On: worker скачивает входные файлы из storage, загружает их в Pruna `/v1/files`, запускает `/v1/predictions` и сохраняет result URL обратно в storage.
- `pixelcut` - Pixelcut Try-On API: worker отправляет `person_image_url` и `garment_image_url`, поэтому входные `StorageObjectRef.url` должны быть публично доступны внешнему API.
- `tryoncloud` - TryOnCloud Developer API или Platform API. `developer` отправляет файлы и получает raw PNG, `platform` отправляет `user_image` + публичный `product_image_url`.
- `genlook` - Genlook Try-On API: worker загружает person image, создает generation и polling-ом ждет результат. Auth header и paths вынесены в env.
- `wearfits` - WEARFITS Virtual Try-On API: worker отправляет sync submit на `/api/v1/virtual-fitting`, затем polling-ом ждет job result.
- `openai` - OpenAI/ChatGPT vision adapter: worker отправляет фото пользователя в Responses API как data URL и возвращает текстовый анализ внешности/гардероба. Поддерживает per-job options: `imageDetail`, `textVerbosity`, `reasoningEffort`, `reasoningMode`, `maxOutputTokens`, `store`, `webSearch`, `inputImageUrls`, `maxInputImageUrls`, `imageGeneration`, `toolChoice`.

Для virtual try-on provider-ов worker ожидает минимум два `payload.inputFiles`: `TRYON_PERSON_IMAGE_INDEX` указывает фото пользователя, `TRYON_GARMENT_IMAGE_INDEX` - фото одежды/товара. OpenAI adapter всегда использует person image как первое изображение и может дополнительно получить удаленные изображения через `inputImageUrls`. Результат генеративных provider-ов и OpenAI image generation сохраняется напрямую в object storage под `jobs/<jobId>/results/...`; coordinator получает только `StorageObjectRef` в `TryOnJobResult.files`.

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

Runner выбирает adapter через `payload.model.provider`, а provider model берет из `payload.model.providerModel` с fallback на config adapter-а. Worker регистрирует capabilities `try-on`, `try-on.mock` и `try-on.<provider>` для provider-ов с настроенными ключами.

Для OpenAI web search клиент может передать в `payload.model.options.webSearch` значение `true` или объект:

```json
{
  "webSearch": {
    "searchContextSize": "high",
    "allowedDomains": ["example.com"]
  }
}
```

`allowedDomains` опционален. Если он не передан, model сможет искать по открытой web выдаче. Telegram-сценарий `Идеальный образ` не использует OpenAI web search для товаров: товарные кандидаты приходят из marketplace adapters, а OpenAI получает только изображения для vision-проверки и генерации clean-card.

OpenAI не принимает `web_search` вместе с `reasoningEffort=minimal`, а некоторые модели, например `gpt-5.6-luna`, не принимают `minimal` вообще. Adapter автоматически поднимает такие запросы до `low`, а клиентские сценарии, которые используют web search, vision-проверку товаров или image generation, должны сразу задавать `low`.

Если OpenAI возвращает `429` по rate limit, adapter читает `retry-after` или подсказку `Please try again in ...s`, делает короткий backoff и повторяет Responses-запрос несколько раз перед тем, как пометить job failed.

Для OpenAI vision-проверок клиент может передать дополнительные удаленные изображения:

```json
{
  "inputImageUrls": [
    "https://example.com/product-1.jpg",
    "https://example.com/product-2.jpg"
  ]
}
```

Worker всегда добавляет основное фото пользователя из `payload.inputFiles` первым изображением, а затем добавляет `inputImageUrls` в указанном порядке. Дополнительные URL worker сначала скачивает сам, проверяет размер и MIME-тип, конвертирует в data-url и только потом отправляет в OpenAI. Это защищает flow от ситуаций, когда OpenAI не может скачать картинку магазина напрямую или получает от магазина `415/403/HTML`.

Сейчас `inputImageUrls` используется Telegram-сценарием `Идеальный образ`: после поиска через marketplace adapters Ozon/Wildberries бот отправляет найденные product images на отдельную vision-проверку, где модель принимает кандидатов с `canGenerateCleanCard=true`, если из изображения можно надежно выделить один целевой товар. Фото товара на человеке или манекене допустимо, если предмет хорошо виден и его можно отделить от фона.

По умолчанию worker берет до 12 дополнительных `inputImageUrls`. Клиент может поднять лимит через `maxInputImageUrls`; worker всё равно ограничивает его верхним предохранителем `80`. Для batch validation клиент может включить `allowInputImagePlaceholders=true`: тогда битая картинка заменится пустым placeholder-изображением в том же индексе, чтобы один плохой URL не ломал проверку всей пачки.

Для OpenAI image generation клиент может передать `payload.model.options.imageGeneration` как `true` или объект с параметрами built-in tool. Если job содержит только `imageGeneration` tool, worker по умолчанию отправляет `tool_choice=required`; клиент также может задать `toolChoice` явно:

```json
{
  "toolChoice": "required",
  "inputImageUrls": ["https://example.com/product.jpg"],
  "maxInputImageUrls": 1,
  "imageGeneration": {
    "model": "gpt-image-1",
    "quality": "medium",
    "size": "1024x1024",
    "background": "opaque",
    "outputFormat": "png",
    "inputFidelity": "low"
  }
}
```

Adapter извлекает `image_generation_call.result`, сохраняет PNG через `storeResultFromBuffer` и возвращает файл в `TryOnJobResult.files`. `StorageObjectRef.url` содержит короткоживущий signed URL на storage-node, поэтому клиент может сразу отправить изображение пользователю, не проксируя файл через coordinator.

## Добавление нового AI provider-а

1. Добавьте имя provider-а в `TryOnModelProvider` и validator `isTryOnModelProvider` в [contracts](../../shared/contracts/index.ts). Если появляется новый тип задачи, добавьте его в `TryOnModelTask` и `isTryOnModelTask`.
2. Создайте папку `apps/worker/models/<provider>/index.ts`. Adapter должен реализовать `TryOnModelAdapter`: указать `provider`, человекочитаемый `displayName` и метод `run(input)`.
3. Подключите adapter в [models/index.ts](index.ts): импортируйте его и добавьте в массив `adapters`.
4. Добавьте provider-specific config в [worker config](../config/index.ts): отдельный interface, чтение env в `loadWorkerConfig`, defaults и валидацию перечислений/чисел.
5. Добавьте автоматическую capability в `readCapabilities()` через `syncProviderCapability(names, "<provider>", "<PROVIDER_API_KEY>")`. Coordinator выбирает worker-а по capability `try-on.<provider>`, поэтому без этого новые jobs не будут матчиться на нужный worker.
6. Добавьте env-параметры в [.env.example](../../../.env.example) отдельным блоком `Worker AI provider: <Provider>`. Секреты оставляйте пустыми.
7. Добавьте эти env keys в `worker.envKeys` в [scripts/build-dist.mjs](../../../scripts/build-dist.mjs) и в env whitelist [scripts/devtest.mjs](../../../scripts/devtest.mjs), иначе готовый `dist/packages/worker/.env` и `devtest/.env` потеряют настройки provider-а.
8. Если provider возвращает файл или URL результата, сохраняйте результат через helpers из [providerUtils.ts](providerUtils.ts): `storeResultFromUrl`, `storeResultFromResponse`, `storeResultFromBuffer`, `createStoredResult`. В итоговом `TryOnJobResult.files` должны быть `StorageObjectRef`, а не бинарные данные.
9. Для входных изображений используйте `selectTryOnInputFiles`, `selectInputFile`, `downloadInputImage` или `ensurePublicImageUrl`, в зависимости от того, принимает provider binary upload или публичный URL.
10. Ошибки внешнего API приводите к `TryOnModelError` с понятным `code` и `retryable`. Для HTTP-ответов используйте `providerResponseError`/`fetchJson`, если подходит общий формат.
11. Обновите этот README и [worker config README](../config/README.md): перечислите provider, особенности входных файлов, env и ограничения.
12. Проверьте `npm run typecheck`, `npm run build:dist` и `npm run build:devtest`.

Минимальный каркас adapter-а:

```ts
import type { TryOnModelAdapter } from "../types.js";
import { requireApiKey, TryOnModelError } from "../providerUtils.js";

const provider = "<provider>";

export const myProviderTryOnAdapter: TryOnModelAdapter = {
  provider,
  displayName: "My Provider",
  run: async ({ job, config, coordinator, signal }) => {
    const apiKey = requireApiKey(provider, "MY_PROVIDER_API_KEY", config.myProvider.apiKey);

    // 1. Прочитать inputFiles или публичные URLs.
    // 2. Вызвать внешний API с timeout/retry policy.
    // 3. Сохранить generated result в object storage.
    // 4. Вернуть TryOnJobResult.

    throw new TryOnModelError("my_provider_not_implemented", "Adapter is not implemented", false);
  },
};
```
