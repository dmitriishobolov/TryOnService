# Coordinator

Coordinator - центральный сервис TryOnService. Он принимает запросы клиентов на assignment, создает jobs, хранит их состояние, знает о доступных worker'ах и возвращает клиенту подходящий worker endpoint.

Coordinator не выполняет AI-обработку сам и не проксирует клиентские результаты. Его задача - matchmaking между client и worker, учет состояния, защита регистрации и управление масштабированием через worker/client registry.

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
5. API возвращает клиенту `job`, `worker` и готовый `workerRequest` с signed dispatch token.
6. Client отправляет `workerRequest` напрямую worker'у, worker затем сообщает progress/result status обратно в coordinator.

## Реализованные endpoints

- `GET /health` - статус coordinator, worker'ы, service clients и количество queued jobs.
- `GET /jobs` - список jobs в in-memory storage.
- `GET /jobs/:id` - состояние конкретной job.
- `POST /jobs` - создание job assignment клиентом; возвращает выбранный worker endpoint, `workerRequest` и dispatch token.
- `POST /clients/register` - регистрация service client.
- `POST /clients/:clientId/heartbeat` - heartbeat service client.
- `POST /workers/register` - регистрация worker'а.
- `POST /workers/:workerId/heartbeat` - heartbeat worker'а.
- `POST /jobs/:jobId/progress` - обновление прогресса от worker'а.
- `POST /jobs/:jobId/result` - финальный status от worker'а; клиентский результат не обязан попадать в coordinator.

## Что важно сохранить

- Coordinator является источником правды по состоянию jobs.
- Coordinator не должен быть data-plane для клиентских результатов: результат идет worker -> client callback.
- Регистрация worker'ов должна быть защищена ключом.
- Неверные попытки регистрации worker'а считаются по IP и после лимита переводят IP в ban до перезапуска coordinator.
- Регистрация service clients должна быть защищена отдельным ключом.
- Недоступный worker должен автоматически выпадать из активного пула после пропущенных heartbeat.
- Повторные запросы worker'а на обновление статуса должны обрабатываться идемпотентно.
