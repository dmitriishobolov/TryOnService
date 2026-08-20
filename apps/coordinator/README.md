# Coordinator

Coordinator - центральный сервис TryOnService. Он принимает запросы клиентов на assignment, создает jobs, хранит их состояние, знает о доступных worker'ах, service clients и storage-node, а затем возвращает клиенту подходящие endpoints и signed tokens.

Coordinator не выполняет AI-обработку сам, не проксирует клиентские результаты и не гоняет большие файлы. Его задача - matchmaking между client, worker и storage-node, легкое security prepare на выбранном worker-е, выдача scoped storage-access, учет состояния, защита регистрации и управление масштабированием через registry.

## Запуск

```bash
npm run dev:coordinator
```

По умолчанию сервис слушает `http://localhost:3000`.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/coordinator`.

## Подпапки

- [api](api/README.md) - HTTP/API слой для клиентов, worker'ов и внутренних операций.
- [config](config/README.md) - конфигурация coordinator, чтение env и валидация настроек.
- [jobs](jobs/README.md) - модель jobs, статусы, хранение и переходы состояния.
- [persistence](persistence/README.md) - выбор memory/Postgres backend и миграции coordinator tables.
- [registry](registry/README.md) - реестр worker'ов, service clients и storage-node: registration, heartbeat, capacity и capabilities.
- [scheduler](scheduler/README.md) - housekeeping просроченных assignments и освобождение capacity.
- [utils](utils/README.md) - утилитарные функции coordinator: IP extraction, registration guards и helpers без доменной логики.

## Основной поток

1. API принимает запрос на создание примерки.
2. Request валидируется через контракты из `apps/shared`.
3. Coordinator находит callback URL зарегистрированного service client, если запрос пришел с `sourceClientId`.
4. Coordinator выбирает доступный worker и storage-node из `registry`, резервирует worker capacity и создает job со статусом `assigned`.
5. Coordinator вызывает `POST /assignments` выбранного worker'а по per-worker service key из `WORKER_KEYS` или dev fallback `WORKER_SERVICE_KEY`, чтобы подготовить будущий client dispatch и передать worker-у signed callback token.
6. API возвращает клиенту `job`, `worker`, `storage` и готовый `workerRequest` с signed dispatch token. Callback token клиенту не возвращается.
7. Client отправляет `workerRequest` напрямую worker'у, а файлы читает/пишет напрямую через storage-node по storage-access token.
8. Worker сообщает progress/result status обратно в coordinator и результат в callback клиента.

## Реализованные endpoints

- `GET /health` - статус coordinator, worker'ы, service clients и количество queued jobs; требует `x-admin-key`.
- `GET /jobs` - список jobs из активного persistence backend; требует `x-admin-key`.
- `GET /jobs/:id` - состояние конкретной job; требует `x-admin-key`.
- `GET /security/events?limit=100` - последние security audit events; требует `x-admin-key`.
- `POST /storage/register` - регистрация storage-node; требует `x-storage-registration-key` и `x-storage-service-key`.
- `POST /storage/:storageId/heartbeat` - heartbeat storage-node; требует `x-storage-service-key`.
- `POST /storage/access` - выдача подходящего storage-node и scoped token для прямого upload/download; требует `x-client-key` для clients или `x-worker-service-key` для worker'ов.
- `POST /jobs` - создание job assignment зарегистрированным клиентом; требует `x-client-key`, валидный `sourceClientId`, возвращает выбранный worker endpoint, `workerRequest` и dispatch token.
- `POST /clients/register` - регистрация service client; требует `x-client-key`.
- `POST /clients/:clientId/heartbeat` - heartbeat service client; требует `x-client-key`.
- `POST /workers/register` - регистрация worker'а; требует `x-worker-registration-key` и `x-worker-service-key`.
- `POST /workers/:workerId/heartbeat` - heartbeat worker'а; требует `x-worker-service-key`.
- `POST /jobs/:jobId/progress` - обновление прогресса от worker'а; требует `x-worker-service-key`.
- `POST /jobs/:jobId/result` - финальный status от worker'а; требует `x-worker-service-key`; клиентский результат не обязан попадать в coordinator.

## Что важно сохранить

- Coordinator является источником правды по состоянию jobs.
- Postgres, если включен, принадлежит только coordinator: worker/client не получают credentials БД.
- Файлы и изображения должны жить в object storage; в БД хранятся metadata и object keys.
- Coordinator не должен быть data-plane для клиентских результатов: результат идет worker -> client callback.
- Coordinator не должен быть data-plane для файлов: client/worker общаются с storage-node напрямую.
- Перед выдачей worker клиенту coordinator должен подготовить pending assignment на worker-е.
- `callbackUrl` при создании job не должен доверяться клиентскому payload: coordinator берет его только из registry зарегистрированного service client.
- Регистрация worker'ов должна быть защищена отдельным registration key и подтверждением per-worker service key.
- Служебное общение worker/coordinator должно быть защищено per-worker key; общий `WORKER_SERVICE_KEY` допустим только как dev fallback.
- Регистрация и служебное общение storage/coordinator должны быть защищены per-storage key; общий `STORAGE_SERVICE_KEY` допустим только как dev fallback.
- Регистрация service clients и создание jobs должны быть защищены per-client key; общий `CLIENT_REGISTRATION_KEY` допустим только как dev fallback.
- Неверные попытки регистрации worker'а, service client и storage-node считаются по IP и после лимита переводят IP в ban; в Postgres режиме ban переживает restart coordinator.
- Недоступный worker должен автоматически выпадать из активного пула после пропущенных heartbeat.
- Активные jobs упавшего worker'а или service client должны переводиться в `failed`, а pending assignment на worker-е должен отменяться, когда это возможно.
- Повторные запросы worker'а на обновление статуса должны обрабатываться идемпотентно.
- Storage-access для client должен оставаться в namespace `clients/<clientId>`, а worker не должен получать arbitrary prefix за пределами `workers/<workerId>` или `jobs/...`.
- Security-sensitive события пишутся в audit store, а signing tokens должны содержать `tokenId` и `keyVersion`.
