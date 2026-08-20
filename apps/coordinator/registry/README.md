# Service Registry

Registry хранит сведения о worker'ах и service clients, которые доступны coordinator. Worker и client регистрируются сами при запуске, используя API coordinator и свой registration key.

## Что хранит worker registry

- `workerId` - стабильный идентификатор worker'а.
- `baseUrl` - endpoint worker'а, который coordinator вычисляет при регистрации по IP входящего запроса и worker port, либо берет из override.
- `status` - доступен, занят, недоступен, выключается.
- `capacity` - сколько задач worker может обрабатывать параллельно.
- `capabilities` - какие модели, пайплайны или типы задач поддерживаются.
- `lastHeartbeatAt` - время последнего heartbeat.

## Что хранит client registry

- `clientId` - стабильный идентификатор service client.
- `type` - тип интеграции, сейчас `telegram`.
- `baseUrl` - endpoint callback server'а клиента.
- `callbackUrl` - путь для результата job, собранный из `baseUrl` и `callbackPath`.
- `status` - `ready` или `offline`.
- `lastHeartbeatAt` - время последнего heartbeat.

## Жизненный цикл worker

1. Worker стартует и читает свой config.
2. Worker вызывает registration endpoint coordinator.
3. Coordinator проверяет ключ и сохраняет worker в registry.
4. Worker регулярно отправляет heartbeat.
5. Если heartbeat пропущен, worker исключается из активного пула.

Service client проходит похожий цикл: стартует, выбирает свободный callback port, регистрируется через `POST /clients/register`, затем отправляет heartbeat.

## Правила

- Registry должен поддерживать горизонтальное масштабирование: несколько worker'ов могут иметь одинаковые capabilities.
- Scheduler не должен назначать jobs worker'у, у которого истек heartbeat.
- Обновление registration должно быть идемпотентным: перезапуск worker'а не должен создавать дубликаты.
- Client registry нужен coordinator, чтобы подставлять callback URL в job по `sourceClientId`.
