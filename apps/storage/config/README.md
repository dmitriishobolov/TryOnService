# Storage Config

Конфигурация storage-node собирается из `.env` в `config/index.ts`.

## Основные настройки

- `STORAGE_PORT` - основной порт storage-node.
- `STORAGE_ID` - опциональный ручной идентификатор storage-node. Если пусто, storage-node сам сгенерирует id и сохранит его на диске.
- `STORAGE_ID_PATH` - опциональный путь к файлу auto-id; если пусто, используется `STORAGE_LOCAL_ROOT/.tryon-storage-id`.
- `STORAGE_PUBLIC_PROTOCOL` - `http` или `https`, используется coordinator-ом при автоопределении endpoint.
- `STORAGE_PUBLIC_URL` - ручной публичный endpoint, если автоопределение по IP/port не подходит.
- `COORDINATOR_URL` - адрес coordinator для registration/heartbeat.
- `STORAGE_REGISTRATION_KEY` - ключ регистрации storage-node в coordinator.
- `STORAGE_SERVICE_KEY` - общий service key для heartbeat/health после регистрации.
- `STORAGE_ACCESS_SIGNING_KEY` - секрет проверки storage-access token; должен совпадать с coordinator.
- `STORAGE_ACCESS_SIGNING_KEY_VERSION` - версия storage-access signing key; storage-node принимает только token текущей версии.
- `STORAGE_DRIVER` - `local` или `s3`.
- `STORAGE_LOCAL_ROOT` - локальная папка для объектов в dev/local backend.
- `STORAGE_METADATA_PATH` - файл metadata index для объектов и инкрементального `usedBytes`.
- `STORAGE_CATALOG_PATH` - файл catalog index, где storage-node хранит связи `cacheKey -> objectKey` для distributed cache объектов.
- `STORAGE_S3_ENDPOINT` - endpoint S3-compatible backend.
- `STORAGE_S3_REGION` - region S3-compatible backend.
- `STORAGE_S3_BUCKET` - bucket для объектов.
- `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` - credentials S3-compatible backend.
- `STORAGE_S3_FORCE_PATH_STYLE` - использовать path-style URL `/bucket/key`; удобно для MinIO.
- `STORAGE_CAPACITY_BYTES` - опциональная capacity storage-node; coordinator использует ее вместе с `usedBytes` для выбора менее загруженного узла.
- `STORAGE_HEARTBEAT_INTERVAL_MS` - интервал heartbeat.
- `STORAGE_MAX_OBJECT_BYTES` - максимальный размер одного upload.
- `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX_REQUESTS` - базовый fixed-window rate limit.
- `HTTP_CLIENT_TIMEOUT_MS`, `HTTP_CLIENT_RETRIES` - timeout/retry для исходящих запросов к coordinator.
- `MAX_JSON_BODY_BYTES` - лимит JSON body для service endpoints.

## Правила

- Не храните production secrets в git.
- Для горизонтального масштабирования storage обычно оставляют `STORAGE_ID` пустым: новый узел достаточно развернуть с registration/service keys и доступом к coordinator.
- `STORAGE_ACCESS_SIGNING_KEY` и `STORAGE_ACCESS_SIGNING_KEY_VERSION` должны быть одинаковыми у coordinator и всех storage-node, иначе issued tokens не будут проходить проверку.
- Если storage-node работает за доменом, reverse proxy или NAT, задайте `STORAGE_PUBLIC_URL`.
