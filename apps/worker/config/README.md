# Worker Config

Папка для конфигурации worker: адрес coordinator, registration key, лимиты параллельной обработки, настройки AI API и локальных временных директорий.

## Рекомендуемые настройки

- `WORKER_ID` - стабильный идентификатор worker'а. Если не задан, может генерироваться при старте.
- `WORKER_PORT` - желаемый порт worker'а; если занят, worker выберет ближайший свободный.
- `WORKER_PUBLIC_PROTOCOL` - протокол endpoint, который coordinator соберет по IP registration-запроса.
- `WORKER_PUBLIC_URL` - опциональный ручной override публичного endpoint worker'а.
- `WORKER_CAPACITY` - количество jobs, которые worker может выполнять параллельно.
- `WORKER_CAPABILITIES` - ручные дополнительные capabilities. Worker автоматически добавляет `try-on`, `try-on.mock`, `try-on.<provider>` для AI provider-ов с API keys и `market.<provider>` для доступных marketplace adapters.
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
- `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`, `OPENAI_IMAGE_DETAIL`, `OPENAI_TEXT_VERBOSITY`, `OPENAI_REASONING_EFFORT`, `OPENAI_REASONING_MODE`, `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_STORE_RESPONSE`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, `OPENAI_SYSTEM_PROMPT`, `OPENAI_WARDROBE_PROMPT` - настройки OpenAI/ChatGPT vision adapter для анализа внешности и подбора гардероба. `OPENAI_MODEL` используется только как fallback, если клиент не передал `payload.model.providerModel`.
- `MARKET_ENABLED`, `MARKET_PROVIDERS`, `MARKET_SEARCH_LIMIT`, `MARKET_STORAGE_CACHE_ENABLED`, `MARKET_STORAGE_CACHE_TTL_MS` - общие настройки marketplace lookup и общего storage-cache. Поиск запускается только если client передал `payload.market`.
- `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`, `ALIEXPRESS_APP_SIGNATURE`, `ALIEXPRESS_TRACKING_ID`, `ALIEXPRESS_API_BASE_URL`, `ALIEXPRESS_SIGN_METHOD`, `ALIEXPRESS_TARGET_LANGUAGE`, `ALIEXPRESS_TARGET_CURRENCY`, `ALIEXPRESS_SHIP_TO_COUNTRY`, `ALIEXPRESS_FIELDS`, `ALIEXPRESS_SORT`, `ALIEXPRESS_DELIVERY_DAYS`, `ALIEXPRESS_PLATFORM_PRODUCT_TYPE` - настройки AliExpress Open Platform / Affiliate API.
- `OZON_PUBLIC_SEARCH_BASE_URL`, `OZON_PUBLIC_PRODUCT_BASE_URL`, `OZON_PUBLIC_SEARCH_PAGES`, `OZON_MAX_SCAN_PRODUCTS`, `OZON_PRODUCT_URL_TEMPLATE`, `OZON_PUBLIC_USER_AGENT` - настройки Ozon public parser. Adapter ищет ссылки `/product/` на HTML-странице поиска и читает карточки из HTML/JSON-LD/meta без Seller API keys.
- `OZON_PUBLIC_CACHE_TTL_MS`, `OZON_PUBLIC_CACHE_STALE_TTL_MS`, `OZON_PUBLIC_CACHE_MAX_ENTRIES`, `OZON_PUBLIC_ERROR_COOLDOWN_MS` - in-memory cache публичного поиска Ozon на worker-е: fresh TTL, fallback stale TTL, максимум cache entries и пауза новых miss-запросов после rate-limit/redirect-loop.
- `WILDBERRIES_LOCALE`, `WILDBERRIES_PRODUCT_URL_TEMPLATE`, `WILDBERRIES_PUBLIC_SEARCH_BASE_URL`, `WILDBERRIES_PUBLIC_SEARCH_PATH`, `WILDBERRIES_PUBLIC_DEST`, `WILDBERRIES_PUBLIC_SORT`, `WILDBERRIES_PUBLIC_SPP`, `WILDBERRIES_PUBLIC_USER_AGENT` - настройки публичного поиска Wildberries. Adapter ходит в JSON endpoint `search.wb.ru`, который использует сайт, с browser-like заголовками, но без captcha/proxy/stealth обхода.
- `WILDBERRIES_PUBLIC_CACHE_TTL_MS`, `WILDBERRIES_PUBLIC_CACHE_STALE_TTL_MS`, `WILDBERRIES_PUBLIC_CACHE_MAX_ENTRIES`, `WILDBERRIES_PUBLIC_ERROR_COOLDOWN_MS` - in-memory cache публичной выдачи WB на worker-е: fresh TTL, fallback stale TTL после fresh TTL, максимум cache entries и пауза новых miss-запросов после 429.
- Где получить marketplace credentials и какие права выбрать, описано в [market/API_KEYS.md](../market/API_KEYS.md).
- `API_RATE_LIMIT_WINDOW_MS` - окно входящего rate limit.
- `API_RATE_LIMIT_MAX_REQUESTS` - максимум входящих запросов с одного IP за окно.
- `HTTP_CLIENT_TIMEOUT_MS` - timeout исходящих HTTP-вызовов worker.
- `HTTP_CLIENT_RETRIES` - количество повторов исходящих HTTP-вызовов worker.
- `MAX_JSON_BODY_BYTES` - максимальный размер JSON body входящего запроса.

Production API keys не хранятся в git. Для `npm run build:dist` значения API keys и public parser settings подтягиваются из `BUILD_ENV_FILE` и попадают в готовый пакет worker-а в `dist/packages/worker/.env`. Конкретный AI provider и provider model выбирает клиент в `payload.model`, marketplace lookup - в `payload.market`; worker env задает только доступные credentials, defaults и capabilities.

## Правила

- Config должен валидироваться при старте worker.
- Production-секреты не хранятся в git.
- Лимиты обработки задаются конфигом, чтобы worker'ы разных размеров могли жить в одной системе.
