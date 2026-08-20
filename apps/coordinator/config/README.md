# Coordinator Config

Папка для конфигурации coordinator: чтение переменных окружения, дефолты, проверка обязательных параметров и экспорт типизированного config object.

## Рекомендуемые настройки

- `COORDINATOR_PORT` - порт HTTP API coordinator.
- `COORDINATOR_PUBLIC_URL` - публичный URL, если нужен callback или внешняя ссылка на API.
- `WORKER_REGISTRATION_KEY` - ключ, по которому worker регистрируется в coordinator.
- `CLIENT_REGISTRATION_KEY` - ключ, по которому service client регистрируется в coordinator.
- `WORKER_HEARTBEAT_INTERVAL_MS` - интервал heartbeat worker'ов.
- `JOB_ASSIGNMENT_TIMEOUT_MS` - таймаут назначения job worker'у.
- `WORKER_HEARTBEAT_TIMEOUT_MS` - время, после которого worker считается недоступным.
- `CLIENT_HEARTBEAT_INTERVAL_MS` - интервал heartbeat service clients.
- `CLIENT_HEARTBEAT_TIMEOUT_MS` - время, после которого service client считается недоступным.

## Правила

- Не обращайтесь к `process.env` по всему коду напрямую: соберите и провалидируйте конфиг в одном месте.
- Секреты не должны иметь дефолтных production-значений.
- Ошибка конфигурации должна падать при старте сервиса, а не во время обработки job.
