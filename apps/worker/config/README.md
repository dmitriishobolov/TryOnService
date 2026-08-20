# Worker Config

Папка для конфигурации worker: адрес coordinator, registration key, лимиты параллельной обработки, настройки AI API и локальных временных директорий.

## Рекомендуемые настройки

- `WORKER_ID` - стабильный идентификатор worker'а. Если не задан, может генерироваться при старте.
- `WORKER_PORT` - желаемый порт worker'а; если занят, worker выберет ближайший свободный.
- `WORKER_PUBLIC_PROTOCOL` - протокол endpoint, который coordinator соберет по IP registration-запроса.
- `WORKER_PUBLIC_URL` - опциональный ручной override публичного endpoint worker'а.
- `WORKER_CAPACITY` - количество jobs, которые worker может выполнять параллельно.
- `WORKER_CAPABILITIES` - список поддерживаемых моделей или пайплайнов.
- `COORDINATOR_URL` - адрес coordinator API.
- `WORKER_REGISTRATION_KEY` - ключ для регистрации в coordinator.
- `WORKER_SERVICE_KEY` - общий service key для heartbeat, progress/result и приема prepare/cancel от coordinator после регистрации.
- `WORKER_DISPATCH_SIGNING_KEY` - секрет проверки dispatch token, который coordinator выдал клиенту.
- `WORKER_DISPATCH_SIGNING_KEY_VERSION` - версия dispatch signing key; worker принимает только token текущей версии.
- `WORKER_HEARTBEAT_INTERVAL_MS` - интервал heartbeat worker'а.
- `MOCK_PROCESSING_DELAY_MS` - задержка mock AI model для локальной проверки.
- `API_RATE_LIMIT_WINDOW_MS` - окно входящего rate limit.
- `API_RATE_LIMIT_MAX_REQUESTS` - максимум входящих запросов с одного IP за окно.
- `HTTP_CLIENT_TIMEOUT_MS` - timeout исходящих HTTP-вызовов worker.
- `HTTP_CLIENT_RETRIES` - количество повторов исходящих HTTP-вызовов worker.
- `MAX_JSON_BODY_BYTES` - максимальный размер JSON body входящего запроса.

AI provider keys и директории временных файлов появятся здесь, когда runner начнет работать с реальными изображениями и внешними AI API.

## Правила

- Config должен валидироваться при старте worker.
- Production-секреты не хранятся в git.
- Лимиты обработки задаются конфигом, чтобы worker'ы разных размеров могли жить в одной системе.
