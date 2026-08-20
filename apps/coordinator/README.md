# Coordinator

Coordinator - центральный сервис TryOnService. Он принимает запросы клиентов, создает jobs, хранит их состояние, знает о доступных worker'ах и назначает задания на выполнение.

Coordinator не выполняет AI-обработку сам. Его задача - надежная маршрутизация, учет состояния и управление масштабированием через worker registry и scheduler.

## Подпапки

- [api](api/README.md) - HTTP/API слой для клиентов, worker'ов и внутренних операций.
- [config](config/README.md) - конфигурация coordinator, чтение env и валидация настроек.
- [jobs](jobs/README.md) - модель jobs, статусы, хранение и переходы состояния.
- [registry](registry/README.md) - реестр worker'ов, registration, heartbeat, capacity и capabilities.
- [scheduler](scheduler/README.md) - логика выбора worker'а, назначения jobs, retries и timeouts.

## Основной поток

1. API принимает запрос на создание примерки.
2. Request валидируется через контракты из `apps/shared`.
3. В `jobs` создается новая задача со статусом `queued`.
4. `scheduler` выбирает подходящий worker из `registry`.
5. Coordinator назначает job worker'у и переводит ее в `assigned` или `running`.
6. Worker сообщает промежуточный и финальный статус обратно в coordinator.

## Что важно сохранить

- Coordinator является источником правды по состоянию jobs.
- Регистрация worker'ов должна быть защищена ключом.
- Недоступный worker должен автоматически выпадать из активного пула после пропущенных heartbeat.
- Повторные запросы worker'а на обновление статуса должны обрабатываться идемпотентно.
