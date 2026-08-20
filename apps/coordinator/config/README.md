# Coordinator Config

Папка для конфигурации coordinator: чтение переменных окружения, дефолты, проверка обязательных параметров и экспорт типизированного config object.

## Рекомендуемые настройки

- `COORDINATOR_PORT` - порт HTTP API coordinator.
- `COORDINATOR_PUBLIC_URL` - публичный URL, если нужен callback или внешняя ссылка на API.
- `WORKER_REGISTRATION_KEY` - ключ, по которому worker регистрируется в coordinator.
- `WORKER_SERVICE_KEY` - ключ служебных запросов coordinator <-> worker после регистрации.
- `WORKER_DISPATCH_SIGNING_KEY` - секрет подписи dispatch token для прямого client -> worker запроса.
- `CLIENT_CALLBACK_SIGNING_KEY` - секрет подписи callback token для результата worker -> client.
- `ADMIN_API_KEY` - ключ доступа к debug/admin endpoints.
- `WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS` - лимит неверных worker registration ключей с одного IP до бана.
- `CLIENT_REGISTRATION_KEY` - ключ, по которому service client регистрируется в coordinator.
- `WORKER_HEARTBEAT_INTERVAL_MS` - интервал heartbeat worker'ов.
- `WORKER_HEARTBEAT_TIMEOUT_MS` - время, после которого worker считается недоступным.
- `CLIENT_HEARTBEAT_INTERVAL_MS` - интервал heartbeat service clients.
- `CLIENT_HEARTBEAT_TIMEOUT_MS` - время, после которого service client считается недоступным.
- `SCHEDULER_INTERVAL_MS` - базовый интервал scheduler loop.
- `WORKER_DISPATCH_TOKEN_TTL_MS` - срок жизни token для прямой отправки job клиентом на worker.
- `CLIENT_CALLBACK_TOKEN_TTL_MS` - срок жизни token для callback результата от worker к client.
- `JOB_ASSIGNMENT_TIMEOUT_MS` - timeout assignment, после которого coordinator освобождает worker capacity.
- `API_RATE_LIMIT_WINDOW_MS` - окно rate limit.
- `API_RATE_LIMIT_MAX_REQUESTS` - максимум запросов с одного direct IP за окно.
- `HTTP_CLIENT_TIMEOUT_MS` - timeout исходящих HTTP-вызовов coordinator.
- `HTTP_CLIENT_RETRIES` - количество повторов исходящих HTTP-вызовов coordinator.
- `MAX_JSON_BODY_BYTES` - максимальный размер JSON body входящего запроса.
- `COORDINATOR_PERSISTENCE` - `memory` или `postgres`.
- `POSTGRES_URL` - строка подключения к Postgres, используется только coordinator.
- `POSTGRES_SSL` - включить SSL для подключения к Postgres.
- `POSTGRES_MAX_CONNECTIONS` - максимальный размер pool coordinator.
- `STORAGE_DRIVER` - `local` сейчас, `s3` зарезервирован для production backend.
- `STORAGE_LOCAL_ROOT` - папка local object storage для dev.
- `STORAGE_PUBLIC_BASE_URL` - публичная база URL, если local storage отдается через reverse proxy.
- `STORAGE_BUCKET` - имя bucket для будущего S3-compatible backend.
- `STORAGE_SIGNED_URL_TTL_MS` - TTL будущих signed storage URLs.

## Правила

- Не обращайтесь к `process.env` по всему коду напрямую: соберите и провалидируйте конфиг в одном месте.
- Секреты не должны иметь дефолтных production-значений.
- Ошибка конфигурации должна падать при старте сервиса, а не во время обработки job.
