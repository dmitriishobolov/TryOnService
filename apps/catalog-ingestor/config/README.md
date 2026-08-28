# Catalog Ingestor Config

Catalog ingestor читает общий `.env` через `loadEnvFile()` и использует те же transport/security настройки, что остальные service clients.

Основные переменные:

- `CATALOG_INGESTOR_CLIENT_ID` - id service client в coordinator.
- `CATALOG_INGESTOR_PORT` - preferred порт health/callback endpoint.
- `CATALOG_INGESTOR_PUBLIC_PROTOCOL` и `CATALOG_INGESTOR_PUBLIC_URL` - как coordinator увидит endpoint сервиса.
- `CATALOG_INGESTOR_ENABLED` - включает периодический sync.
- `CATALOG_INGESTOR_RUN_ON_START` - запускать sync сразу после старта.
- `CATALOG_INGESTOR_SYNC_INTERVAL_MS` - период повторного обхода provider-ов.
- `CATALOG_INGESTOR_BATCH_SIZE` - лимит товаров за цикл на provider.
- `CATALOG_INGESTOR_PROVIDERS` - список подключенных provider-ов. Для вашего parser-а используйте `custom`.
- `CATALOG_INGESTOR_STORAGE_PREFIX` - root prefix для объектов и catalog entries. Если пусто, используется `clients/<clientId>/catalog`.
- `CATALOG_INGESTOR_USER_AGENT` - User-Agent для будущих provider HTTP-запросов и скачивания изображений.
- `CATALOG_INGESTOR_CUSTOM_SOURCE_FILE` - optional JSON dataset для provider-а `custom`; удобно для тестового наполнения каталога без реального парсинга.
- `CATALOG_INGESTOR_IMAGE_DOWNLOAD_TIMEOUT_MS` и `CATALOG_INGESTOR_MAX_IMAGE_BYTES` - лимиты подготовки изображений.

Для доступа к coordinator используются:

- `COORDINATOR_URL` - адрес coordinator.
- `CLIENT_REGISTRATION_KEY` - общий ключ регистрации service clients и запросов catalog ingestor к coordinator.
- `CLIENT_HEARTBEAT_INTERVAL_MS` - период heartbeat, если нужно переопределить общий default.
