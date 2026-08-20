# Storage Config

Конфигурация storage-node собирается из `.env` в `config/index.ts`.

## Основные настройки

- `STORAGE_PORT` - основной порт storage-node.
- `STORAGE_ID` - стабильный идентификатор storage-node.
- `STORAGE_PUBLIC_PROTOCOL` - `http` или `https`, используется coordinator-ом при автоопределении endpoint.
- `STORAGE_PUBLIC_URL` - ручной публичный endpoint, если автоопределение по IP/port не подходит.
- `COORDINATOR_URL` - адрес coordinator для registration/heartbeat.
- `STORAGE_REGISTRATION_KEY` - ключ регистрации storage-node в coordinator.
- `STORAGE_KEY` - per-storage service key для registration proof и heartbeat/health; должен совпадать с `STORAGE_KEYS[STORAGE_ID]` на coordinator.
- `STORAGE_SERVICE_KEY` - dev fallback service key, если per-storage keys еще не включены.
- `STORAGE_ACCESS_SIGNING_KEY` - секрет проверки storage-access token; должен совпадать с coordinator.
- `STORAGE_ACCESS_SIGNING_KEY_VERSION` - версия storage-access signing key; storage-node принимает только token текущей версии.
- `STORAGE_DRIVER` - `local` сейчас, `s3` зарезервирован как следующий backend.
- `STORAGE_LOCAL_ROOT` - локальная папка для объектов в dev/local backend.
- `STORAGE_CAPACITY_BYTES` - опциональная capacity storage-node.
- `STORAGE_HEARTBEAT_INTERVAL_MS` - интервал heartbeat.
- `STORAGE_MAX_OBJECT_BYTES` - максимальный размер одного upload.
- `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX_REQUESTS` - базовый fixed-window rate limit.
- `HTTP_CLIENT_TIMEOUT_MS`, `HTTP_CLIENT_RETRIES` - timeout/retry для исходящих запросов к coordinator.
- `MAX_JSON_BODY_BYTES` - лимит JSON body для service endpoints.

## Правила

- Не храните production secrets в git.
- `STORAGE_ACCESS_SIGNING_KEY` и `STORAGE_ACCESS_SIGNING_KEY_VERSION` должны быть одинаковыми у coordinator и всех storage-node, иначе issued tokens не будут проходить проверку.
- Если storage-node работает за доменом, reverse proxy или NAT, задайте `STORAGE_PUBLIC_URL`.
