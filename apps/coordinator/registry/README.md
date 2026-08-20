# Worker Registry

Registry хранит сведения о worker'ах, которые доступны coordinator. Worker регистрируется сам при запуске, используя API coordinator и ключ регистрации.

## Что хранит registry

- `workerId` - стабильный идентификатор worker'а.
- `baseUrl` - endpoint worker'а, который coordinator вычисляет при регистрации по IP входящего запроса и worker port, либо берет из override.
- `status` - доступен, занят, недоступен, выключается.
- `capacity` - сколько задач worker может обрабатывать параллельно.
- `capabilities` - какие модели, пайплайны или типы задач поддерживаются.
- `lastHeartbeatAt` - время последнего heartbeat.

## Жизненный цикл worker

1. Worker стартует и читает свой config.
2. Worker вызывает registration endpoint coordinator.
3. Coordinator проверяет ключ и сохраняет worker в registry.
4. Worker регулярно отправляет heartbeat.
5. Если heartbeat пропущен, worker исключается из активного пула.

## Правила

- Registry должен поддерживать горизонтальное масштабирование: несколько worker'ов могут иметь одинаковые capabilities.
- Scheduler не должен назначать jobs worker'у, у которого истек heartbeat.
- Обновление registration должно быть идемпотентным: перезапуск worker'а не должен создавать дубликаты.
