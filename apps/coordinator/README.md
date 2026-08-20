# Coordinator

Coordinator - центральный сервис TryOnService. Он принимает запросы клиентов на assignment, создает jobs, хранит их состояние, знает о доступных worker'ах и возвращает клиенту подходящий worker endpoint.

Coordinator не выполняет AI-обработку сам и не проксирует клиентские результаты. Его задача - matchmaking между client и worker, легкое security prepare на выбранном worker-е, учет состояния, защита регистрации и управление масштабированием через worker/client registry.

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
- [registry](registry/README.md) - реестр worker'ов, registration, heartbeat, capacity и capabilities.
- [scheduler](scheduler/README.md) - in-memory housekeeping просроченных assignments и освобождение capacity.
- [utils](utils/README.md) - утилитарные функции coordinator: IP extraction, registration guards и helpers без доменной логики.

## Основной поток

1. API принимает запрос на создание примерки.
2. Request валидируется через контракты из `apps/shared`.
3. Coordinator находит callback URL зарегистрированного service client, если запрос пришел с `sourceClientId`.
4. Coordinator выбирает доступный worker из `registry`, резервирует его capacity и создает job со статусом `assigned`.
5. Coordinator вызывает `POST /assignments` выбранного worker'а по `WORKER_SERVICE_KEY`, чтобы подготовить будущий client dispatch и передать worker-у signed callback token.
6. API возвращает клиенту `job`, `worker` и готовый `workerRequest` с signed dispatch token. Callback token клиенту не возвращается.
7. Client отправляет `workerRequest` напрямую worker'у, worker затем сообщает progress/result status обратно в coordinator.

## Реализованные endpoints

- `GET /health` - статус coordinator, worker'ы, service clients и количество queued jobs; требует `x-admin-key`.
- `GET /jobs` - список jobs в in-memory storage; требует `x-admin-key`.
- `GET /jobs/:id` - состояние конкретной job; требует `x-admin-key`.
- `POST /jobs` - создание job assignment зарегистрированным клиентом; требует `x-client-key`, валидный `sourceClientId`, возвращает выбранный worker endpoint, `workerRequest` и dispatch token.
- `POST /clients/register` - регистрация service client; требует `x-client-key`.
- `POST /clients/:clientId/heartbeat` - heartbeat service client; требует `x-client-key`.
- `POST /workers/register` - регистрация worker'а; требует `x-worker-registration-key`.
- `POST /workers/:workerId/heartbeat` - heartbeat worker'а; требует `x-worker-service-key`.
- `POST /jobs/:jobId/progress` - обновление прогресса от worker'а; требует `x-worker-service-key`.
- `POST /jobs/:jobId/result` - финальный status от worker'а; требует `x-worker-service-key`; клиентский результат не обязан попадать в coordinator.

## Что важно сохранить

- Coordinator является источником правды по состоянию jobs.
- Coordinator не должен быть data-plane для клиентских результатов: результат идет worker -> client callback.
- Перед выдачей worker клиенту coordinator должен подготовить pending assignment на worker-е.
- `callbackUrl` при создании job не должен доверяться клиентскому payload: coordinator берет его только из registry зарегистрированного service client.
- Регистрация worker'ов должна быть защищена отдельным registration key.
- Служебное общение worker/coordinator должно быть защищено отдельным service key.
- Неверные попытки регистрации worker'а считаются по IP и после лимита переводят IP в ban до перезапуска coordinator.
- Регистрация service clients должна быть защищена отдельным ключом.
- Недоступный worker должен автоматически выпадать из активного пула после пропущенных heartbeat.
- Активные jobs упавшего worker'а или service client должны переводиться в `failed`, а pending assignment на worker-е должен отменяться, когда это возможно.
- Повторные запросы worker'а на обновление статуса должны обрабатываться идемпотентно.
