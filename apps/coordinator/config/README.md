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
- `STORAGE_REGISTRATION_KEY` - ключ, по которому storage-node регистрируется в coordinator.
- `STORAGE_SERVICE_KEY` - ключ служебных запросов coordinator <-> storage-node после регистрации.
- `STORAGE_ACCESS_SIGNING_KEY` - секрет подписи storage-access token для прямой связи client/worker -> storage-node.
- `STORAGE_REGISTRATION_MAX_INVALID_ATTEMPTS` - лимит неверных storage registration ключей с одного IP до бана.
- `CLIENT_REGISTRATION_KEY` - ключ, по которому service client регистрируется в coordinator.
- `WORKER_HEARTBEAT_INTERVAL_MS` - интервал heartbeat worker'ов.
- `WORKER_HEARTBEAT_TIMEOUT_MS` - время, после которого worker считается недоступным.
- `CLIENT_HEARTBEAT_INTERVAL_MS` - интервал heartbeat service clients.
- `CLIENT_HEARTBEAT_TIMEOUT_MS` - время, после которого service client считается недоступным.
- `STORAGE_HEARTBEAT_INTERVAL_MS` - интервал heartbeat storage-node.
- `STORAGE_HEARTBEAT_TIMEOUT_MS` - время, после которого storage-node считается недоступным.
- `SCHEDULER_INTERVAL_MS` - базовый интервал scheduler loop.
- `WORKER_DISPATCH_TOKEN_TTL_MS` - срок жизни token для прямой отправки job клиентом на worker.
- `CLIENT_CALLBACK_TOKEN_TTL_MS` - срок жизни token для callback результата от worker к client.
- `STORAGE_ACCESS_TOKEN_TTL_MS` - срок жизни token для прямого upload/download в storage-node.
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

## Правила

- Не обращайтесь к `process.env` по всему коду напрямую: соберите и провалидируйте конфиг в одном месте.
- Секреты не должны иметь дефолтных production-значений.
- Ошибка конфигурации должна падать при старте сервиса, а не во время обработки job.
