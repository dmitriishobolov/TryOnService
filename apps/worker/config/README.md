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
- `WORKER_HEARTBEAT_INTERVAL_MS` - интервал heartbeat worker'а.
- `MOCK_PROCESSING_DELAY_MS` - задержка mock AI model для локальной проверки.

AI provider keys и директории временных файлов появятся здесь, когда runner начнет работать с реальными изображениями и внешними AI API.

## Правила

- Config должен валидироваться при старте worker.
- Production-секреты не хранятся в git.
- Лимиты обработки задаются конфигом, чтобы worker'ы разных размеров могли жить в одной системе.
