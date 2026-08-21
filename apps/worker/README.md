# Worker

Worker - сервис-исполнитель TryOnService. Он запускается на отдельном сервере, регистрируется в coordinator и выполняет тяжелую обработку клиентских данных через AI API.

Worker можно масштабировать горизонтально: поднимаем новый экземпляр, он сообщает coordinator о готовности, после чего coordinator может выдавать клиентам assignment на этот worker.

## Запуск

```bash
npm run dev:worker
```

По умолчанию worker пытается слушать порт `4001`. Если порт занят, worker выберет ближайший свободный порт, зарегистрирует его в coordinator и будет отправлять heartbeat каждые 5 секунд. Публичный адрес worker'а не нужно указывать напрямую: coordinator определяет IP по registration-запросу и собирает endpoint из `WORKER_PUBLIC_PROTOCOL` + IP + фактический worker port.

Если worker стоит за reverse proxy, NAT или доменом, где автоопределение не подходит, можно задать `WORKER_PUBLIC_URL` как ручной override.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/worker`.

## Подпапки

- [api](api/README.md) - связь worker'а с coordinator и локальный endpoint приема jobs от клиентов.
- [config](config/README.md) - настройки worker, AI API keys, лимиты и адрес coordinator.
- [market](market/README.md) - adapters к marketplace API для поиска одежды и выставочных фото товаров.
- [models](models/README.md) - адаптеры к AI API и конкретным моделям.
- [runner](runner/README.md) - пайплайны обработки данных клиента.
- [utils](utils/README.md) - общие утилиты worker'а.

## Жизненный цикл

1. Worker стартует и загружает config.
2. Worker формирует `workerId`, `capacity` и список `capabilities`.
3. Worker регистрируется в coordinator через API и общий registration key.
4. Worker регулярно отправляет heartbeat.
5. Coordinator отправляет worker-у lightweight `POST /assignments` с `x-worker-service-key`, чтобы подготовить pending assignment под будущий client dispatch и передать callback token.
6. Client получает assignment от coordinator и отправляет heavy request на worker endpoint `POST /jobs` с `x-job-dispatch-token`.
7. Worker проверяет purpose/signature dispatch token, `workerId`, `jobId`, текущий signing `keyVersion`, одноразовый `tokenId` и pending assignment, скачивает входные файлы по `StorageObjectRef`, запускает runner, при наличии `payload.market` ищет товары через `market`, затем вызывает adapter из `models`, выбранный клиентом в `payload.model.provider`; конкретная модель provider-а берется из `payload.model.providerModel`.
8. Worker использует storage-access из `workerRequest` или запрашивает новый через `POST /storage/access`, читает входные файлы и загружает generated files напрямую в storage-node, отправляет progress/final status в coordinator по `x-worker-service-key` и клиентский результат напрямую в callback клиента с `x-client-callback-token`. Найденные marketplace-товары возвращаются в `TryOnJobResult.marketProducts` и кратко дублируются в тексте результата.

Если клиент не указал `payload.model.provider`, runner использует `mock` и возвращает текст `Ответ от сервера.`. Клиент может запросить `pruna`, `pixelcut`, `tryoncloud`, `genlook`, `wearfits` или `openai`; worker примет job только если у него есть соответствующая capability. Если `providerModel` не передан, adapter использует свой fallback из config. Подробности в [models](models/README.md) и [config](config/README.md).

Marketplace lookup включается только если клиент передал `payload.market`. Сейчас доступны `aliexpress`, `ozon`, `wildberries`, `tsum`, `tsum-outlet`, `ostin`, `2mood` и `lime`; worker примет provider в поиск только если он включен в `MARKET_PROVIDERS` и доступен выбранный adapter. Ozon, Wildberries, TSUM, TSUM Outlet, O'STIN, 2MOOD и LIMÉ работают через public parsers без seller-token; AliExpress использует Open Platform / Affiliate API. При `MARKET_STORAGE_CACHE_ENABLED=true` worker сначала проверяет distributed storage catalog, а после live-поиска сохраняет `market-search`/`market-product` cache entries. Подробности и инструкция по добавлению новых marketplace provider-ов находятся в [market](market/README.md).

## Расширение worker-а

- Новый AI provider добавляйте через [models](models/README.md#добавление-нового-ai-provider-а): contract, config/env, capability `try-on.<provider>`, adapter registry и build/devtest env whitelist.
- Новый marketplace provider добавляйте через [market](market/README.md#добавление-нового-marketplace-provider-а): contract, config/env, capability `market.<provider>`, adapter registry и build/devtest env whitelist.
- Новый бизнес-сценарий обработки добавляйте в [runner](runner/README.md), сохраняя HTTP-детали provider-ов внутри `models` или `market`.

## Принципы

- Worker не должен быть источником правды по job state.
- Worker не должен отдавать клиентский результат через coordinator; callback клиента является основным каналом результата.
- Worker не должен хранить generated images как постоянное хранилище: после upload в storage-node локальные временные файлы очищаются.
- Pending assignments должны учитываться в heartbeat load вместе с running jobs.
- Pending assignment должен отменяться через `POST /jobs/:jobId/cancel`, если coordinator сообщает, что клиент пропал или assignment истек.
- Dispatch token должен быть одноразовым: после принятия job повторный token replay отклоняется.
- Временные файлы должны очищаться после обработки.
- Конкретные AI providers изолируются в `models`.
- Runner описывает бизнес-пайплайн, но не знает деталей HTTP API конкретного AI provider.
- Все входные и выходные данные сверяются с контрактами из `apps/shared`.
- Marketplace providers изолируются в `market`, чтобы runner не зависел от API или HTML-структуры конкретного marketplace/catalog сайта.
