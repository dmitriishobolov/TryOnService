# Catalog Ingestor API

Здесь находится локальный HTTP endpoint catalog ingestor и client к coordinator.

## Endpoint сервиса

- `GET /health` - быстрый health check процесса, возвращает `clientId`, `enabled` и список provider-ов.
- `POST /callbacks/jobs` - no-op callback endpoint для совместимости с текущим `POST /clients/register`. Catalog ingestor не принимает пользовательские jobs и не обрабатывает callbacks.

## Coordinator client

`CatalogCoordinatorClient` делает:

- `POST /clients/register` с `type=catalog-ingestor` и `x-client-key`.
- `POST /clients/:clientId/heartbeat`.
- `POST /storage/access` для получения прямого доступа к storage-node.

## Правила

- API не должен принимать команды на парсинг от внешних пользователей.
- Реальный сбор каталога запускается внутренним scheduler-ом, а не публичной ручкой.
- Если позже появится admin endpoint ручного запуска sync, он должен требовать отдельный admin key и rate limit.