# Worker Config

Папка для конфигурации worker: адрес coordinator, registration key, лимиты параллельной обработки, настройки AI API и локальных временных директорий.

## Рекомендуемые настройки

- `WORKER_ID` - стабильный идентификатор worker'а. Если не задан, может генерироваться при старте.
- `WORKER_PORT` - желаемый порт worker'а; если занят, worker выберет ближайший свободный.
- `WORKER_PUBLIC_PROTOCOL` - протокол endpoint, который coordinator соберет по IP registration-запроса.
- `WORKER_PUBLIC_URL` - опциональный ручной override публичного endpoint worker'а.
- `WORKER_CAPACITY` - количество jobs, которые worker может выполнять параллельно.
- `WORKER_CAPABILITIES` - ручные дополнительные capabilities. Worker автоматически добавляет `try-on`, `try-on.mock` и `try-on.<provider>` для provider-ов, чьи API keys заполнены.
- `TRYON_PERSON_IMAGE_INDEX` - индекс фото пользователя в `payload.inputFiles`.
- `TRYON_GARMENT_IMAGE_INDEX` - индекс фото одежды/товара в `payload.inputFiles`.
- `TRYON_MODEL_POLL_INTERVAL_MS` - интервал polling-а async providers.
- `TRYON_MODEL_MAX_POLL_ATTEMPTS` - максимум polling-попыток до timeout.
- `TRYON_MODEL_HTTP_TIMEOUT_MS` - timeout бинарных upload/download и вызовов внешних AI API.
- `COORDINATOR_URL` - адрес coordinator API.
- `WORKER_REGISTRATION_KEY` - ключ для регистрации в coordinator.
- `WORKER_SERVICE_KEY` - общий service key для heartbeat, progress/result и приема prepare/cancel от coordinator после регистрации.
- `WORKER_DISPATCH_SIGNING_KEY` - секрет проверки dispatch token, который coordinator выдал клиенту.
- `WORKER_DISPATCH_SIGNING_KEY_VERSION` - версия dispatch signing key; worker принимает только token текущей версии.
- `WORKER_HEARTBEAT_INTERVAL_MS` - интервал heartbeat worker'а.
- `MOCK_PROCESSING_DELAY_MS` - задержка mock AI model для локальной проверки.
- `PRUNA_API_KEY`, `PRUNA_API_BASE_URL`, `PRUNA_MODEL`, `PRUNA_PREDICTION_PATH_TEMPLATE`, `PRUNA_OUTPUT_FORMAT`, `PRUNA_OUTPUT_QUALITY`, `PRUNA_PRESERVE_INPUT_SIZE`, `PRUNA_PROMPT`, `PRUNA_SEED`, `PRUNA_TURBO` - настройки Pruna P-Image-Try-On.
- `PIXELCUT_API_KEY`, `PIXELCUT_API_BASE_URL`, `PIXELCUT_JOB_STATUS_PATH_TEMPLATE`, `PIXELCUT_GARMENT_MODE`, `PIXELCUT_PREPROCESS_GARMENT`, `PIXELCUT_REMOVE_BACKGROUND` - настройки Pixelcut Try-On API. Pixelcut требует публичные URL входных изображений.
- `TRYONCLOUD_API_KEY`, `TRYONCLOUD_API_BASE_URL`, `TRYONCLOUD_MODE` - настройки TryOnCloud API. `developer` отправляет файлы и получает raw PNG; `platform` требует публичный URL garment image.
- `GENLOOK_API_KEY`, `GENLOOK_API_BASE_URL`, `GENLOOK_API_KEY_HEADER`, `GENLOOK_API_KEY_PREFIX`, `GENLOOK_UPLOAD_MODE`, `GENLOOK_UPLOAD_PATH`, `GENLOOK_TRYON_PATH`, `GENLOOK_GENERATION_PATH_TEMPLATE` - настройки Genlook. Endpoint paths оставлены конфигурируемыми, потому что dashboard/provider setup может отличаться.
- `WEARFITS_API_KEY`, `WEARFITS_API_BASE_URL`, `WEARFITS_IMAGE_INPUT_MODE`, `WEARFITS_PRODUCT_CATEGORY`, `WEARFITS_QUALITY`, `WEARFITS_PRESERVE_BACKGROUND` - настройки WEARFITS Virtual Try-On API.
- `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`, `OPENAI_IMAGE_DETAIL`, `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, `OPENAI_SYSTEM_PROMPT`, `OPENAI_WARDROBE_PROMPT` - настройки OpenAI/ChatGPT vision adapter для анализа внешности и подбора гардероба.
- `API_RATE_LIMIT_WINDOW_MS` - окно входящего rate limit.
- `API_RATE_LIMIT_MAX_REQUESTS` - максимум входящих запросов с одного IP за окно.
- `HTTP_CLIENT_TIMEOUT_MS` - timeout исходящих HTTP-вызовов worker.
- `HTTP_CLIENT_RETRIES` - количество повторов исходящих HTTP-вызовов worker.
- `MAX_JSON_BODY_BYTES` - максимальный размер JSON body входящего запроса.

Production API keys не хранятся в git. Для `npm run build:dist` значения API keys подтягиваются из `BUILD_ENV_FILE` и попадают в готовый пакет worker-а в `dist/packages/worker/.env`. Конкретный provider выбирает клиент в `payload.model`, а не worker env.

## Правила

- Config должен валидироваться при старте worker.
- Production-секреты не хранятся в git.
- Лимиты обработки задаются конфигом, чтобы worker'ы разных размеров могли жить в одной системе.
