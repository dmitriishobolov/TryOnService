# Coordinator

Coordinator - центральный сервис TryOnService. Он принимает запросы клиентов, создает jobs, хранит их состояние, знает о доступных worker'ах и назначает задания на выполнение.

Coordinator не выполняет AI-обработку сам. Его задача - надежная маршрутизация, учет состояния и управление масштабированием через worker registry и scheduler.

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
- [scheduler](scheduler/README.md) - логика выбора worker'а, назначения jobs, retries и timeouts.
- [utils](utils/README.md) - утилитарные функции coordinator: IP extraction, registration guards и helpers без доменной логики.

## Основной поток

1. API принимает запрос на создание примерки.
2. Request валидируется через контракты из `apps/shared`.
3. В `jobs` создается новая задача со статусом `queued`.
4. `scheduler` выбирает подходящий worker из `registry`.
5. Coordinator назначает job worker'у и переводит ее в `assigned`, worker затем сообщает `running`.
6. Worker сообщает промежуточный и финальный статус обратно в coordinator.

## Реализованные endpoints

- `GET /health` - статус coordinator, worker'ы, service clients и количество queued jobs.
- `GET /jobs` - список jobs в in-memory storage.
- `GET /jobs/:id` - состояние конкретной job.
- `POST /jobs` - создание job клиентом.
- `POST /clients/register` - регистрация service client.
- `POST /clients/:clientId/heartbeat` - heartbeat service client.
- `POST /workers/register` - регистрация worker'а.
- `POST /workers/:workerId/heartbeat` - heartbeat worker'а.
- `POST /jobs/:jobId/progress` - обновление прогресса от worker'а.
- `POST /jobs/:jobId/result` - финальный результат от worker'а.

## Что важно сохранить

- Coordinator является источником правды по состоянию jobs.
- Регистрация worker'ов должна быть защищена ключом.
- Неверные попытки регистрации worker'а считаются по IP и после лимита переводят IP в ban до перезапуска coordinator.
- Регистрация service clients должна быть защищена отдельным ключом.
- Недоступный worker должен автоматически выпадать из активного пула после пропущенных heartbeat.
- Повторные запросы worker'а на обновление статуса должны обрабатываться идемпотентно.
