# Service Registry

Registry хранит сведения о worker'ах, service clients и storage-node, которые доступны coordinator. Worker, client и storage-node регистрируются сами при запуске, используя API coordinator и свой registration key.

Хранилище registry выбирается coordinator persistence backend: `memory` для dev или `postgres` для сохранения состояния между рестартами.

## Что хранит worker registry

- `workerId` - стабильный идентификатор worker'а.
- `baseUrl` - endpoint worker'а, который coordinator вычисляет при регистрации по IP входящего запроса и worker port, либо берет из override.
- `status` - доступен, занят, недоступен, выключается.
- `capacity` - сколько задач worker может обрабатывать параллельно.
- `capabilities` - какие модели, пайплайны или типы задач поддерживаются.
- `lastHeartbeatAt` - время последнего heartbeat.

## Что хранит client registry

- `clientId` - стабильный идентификатор service client.
- `type` - тип service client: `telegram` для пользовательского бота или `catalog-ingestor` для сборщика каталога.
- `baseUrl` - endpoint callback server'а клиента.
- `callbackUrl` - путь для результата job, собранный из `baseUrl` и `callbackPath`.
- `status` - `ready` или `offline`.
- `lastHeartbeatAt` - время последнего heartbeat.

## Что хранит storage registry

- `storageId` - стабильный идентификатор storage-node; сам storage может сгенерировать его при первом запуске и хранить в runtime-файле.
- `baseUrl` - endpoint storage-node, который coordinator вычисляет при регистрации по IP входящего запроса и port, либо берет из override.
- `driver` - текущий backend storage-node, сейчас `local` или будущий `s3`.
- `status` - `ready` или `offline`.
- `usedBytes` и `capacityBytes` - опциональные данные загрузки storage-node для выбора подходящего узла.

Storage registry может хранить несколько active storage-node. Для обычного `POST /storage/access` coordinator выбирает один свежий узел с доступной capacity и минимальной долей `usedBytes/capacityBytes`; если несколько узлов одинаково подходят, запросы распределяются между ними. Для `POST /storage/catalog/lookup` coordinator опрашивает все свежие storage-node и возвращает все locations, где найден нужный cache entry.
- `lastHeartbeatAt` - время последнего heartbeat.

## Жизненный цикл worker

1. Worker стартует и читает свой config.
2. Worker вызывает registration endpoint coordinator.
3. Coordinator проверяет ключ и сохраняет worker в registry.
4. Worker регулярно отправляет heartbeat.
5. Если heartbeat пропущен, worker исключается из активного пула.

Service client проходит похожий цикл: стартует, выбирает свободный callback/health port, регистрируется через `POST /clients/register`, затем отправляет heartbeat. Catalog ingestor использует этот же lifecycle, но не создает пользовательские jobs.

Storage-node также стартует самостоятельно, выбирает свободный port, регистрируется через `POST /storage/register`, затем отправляет heartbeat через `POST /storage/:storageId/heartbeat`.

## Правила

- Registry должен поддерживать горизонтальное масштабирование: несколько worker'ов могут иметь одинаковые capabilities.
- Coordinator API не должен выдавать assignment worker'у, у которого истек heartbeat.
- Обновление registration должно быть идемпотентным: перезапуск worker'а не должен создавать дубликаты.
- Client registry нужен coordinator, чтобы подставлять callback URL в job по `sourceClientId`.
- Storage registry нужен coordinator, чтобы выдавать client/worker прямой storage endpoint и scoped access token без передачи файлов через coordinator.
