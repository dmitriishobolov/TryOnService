# TryOnService Monolith MVP

`monolith/` - отдельный мини-MVP TryOnService, полностью изолированный от распределенной архитектуры в `apps/`. В одном Node.js/TypeScript процессе живут Telegram-бот, локальное файловое хранилище, локальный каталог одежды, OpenAI/ChatGPT-анализ и прямой вызов TryOn provider-а.

Монолит нужен для быстрой продуктовой проверки: один `.env`, один запуск, локальная база товаров и понятный путь пользователя. Production-сеть с coordinator, worker, storage-node и catalog-ingestor остается в `apps/` и развивается отдельно.

## Когда Использовать

Используйте `monolith/`, если нужно быстро проверить MVP-сценарий в Telegram без поднятия всей микросервисной сети:

- принять фото пользователя;
- сделать анализ внешности через OpenAI;
- предложить 3 варианта идеального образа;
- выбрать товары из локального каталога;
- отправить фото пользователя и выбранную одежду в TryOn API;
- показать пользователю карточки товаров, ссылки и результат примерки.

Не используйте `monolith/` как замену будущей production-архитектуры под большие объемы. Здесь нет горизонтального масштабирования, общей очереди, распределенного object storage и worker pool.

## Быстрый Старт

```bash
cd monolith
npm install
npm run playwright:install
```

Создайте локальный env:

```powershell
Copy-Item .env.example .env
```

Минимум для запуска бота с mock TryOn:

```env
TELEGRAM_BOT_TOKEN=<telegram-bot-token>
OPENAI_API_KEY=<openai-api-key>
MONOLITH_TRYON_PROVIDER=mock
```

Запуск в dev-режиме:

```bash
npm run dev
```

Production-сборка JS:

```bash
npm run build
npm run start
```

Проверка типов:

```bash
npm run typecheck
```

## Команды

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Запускает Telegram-бота через `tsx`. |
| `npm run start` | Запускает собранный `dist/index.js`. |
| `npm run build` | Собирает TypeScript в `dist/`. |
| `npm run typecheck` | Проверяет типы без сборки. |
| `npm run dev:catalog` | Делает разовый refresh локального каталога. |
| `npm run ingest:tsum:male` | Медленно и resumable собирает мужской каталог TSUM. |
| `npm run playwright:install` | Устанавливает Chromium для Playwright-парсеров. |

Из корня репозитория медленный сбор TSUM можно запустить командой:

```bash
npm run monolith:ingest:tsum:male
```

## Структура

```text
monolith/
  bot/telegramBot.ts                 # Telegram UI и пользовательские сценарии
  catalog/catalog.ts                 # Фасад локального каталога
  catalog/store.ts                   # JSON store товаров, скоринг, категории и aliases
  catalog/runIngest.ts               # Разовый refresh каталога
  catalog/runTsumMaleSlowIngest.ts   # Медленный полный обход мужского TSUM
  catalog/providers/tsum/parser.ts   # Playwright parser TSUM
  providers/openaiVision.ts          # OpenAI Responses API: анализ, план образа
  providers/tryOn.ts                 # TryOn adapters: mock/pruna
  storage/localFileStorage.ts        # Локальное файловое хранилище
  utils/env.ts                       # Env loader
  utils/http.ts                      # HTTP helpers с timeout/download limit
  utils/logger.ts                    # Консольный logger
  config.ts                          # Конфигурация монолита
  index.ts                           # Точка входа
  types.ts                           # Общие типы монолита
```

## Runtime Данные

Все runtime-файлы по умолчанию живут в `monolith/.monolith-data/`. Папка закрыта в `monolith/.gitignore` и не должна попадать в git.

- `.monolith-data/catalog/items.json` - локальная JSON-база товаров.
- `.monolith-data/catalog/tsum-male-ingest-checkpoint.json` - checkpoint медленного обхода TSUM.
- `.monolith-data/catalog-image/` - скачанные изображения товаров.
- `.monolith-data/telegram-input/` - фото, полученные от пользователей Telegram.
- `.monolith-data/tryon-result/` - результаты TryOn provider-а.

Ключевое правило: бот работает с локальными изображениями товаров. В каталоге внешний `imageUrl` остается как источник, но для примерки нужен `localImagePath`.

## Пользовательские Сценарии

### `/start`

Бот показывает короткое описание и две основные кнопки:

- `Анализ внешности`;
- `Идеальный образ`.

Во время активного сценария команды и кнопки, которые могут сбить flow, блокируются. Пользователь может выйти через `Отмена`.

### Анализ Внешности

1. Пользователь выбирает `Анализ внешности`.
2. Бот просит отправить фото с лицом.
3. OpenAI проверяет, что на фото реальный человек и видно лицо.
4. Если фото не подходит, бот просит прислать другое изображение.
5. Если все хорошо, бот выводит короткий живой вывод и структурированный анализ внешности.

Ответ специально ограничен по объему и отправляется с Markdown-разметкой. Длинные ответы режутся на несколько Telegram-сообщений.

### Идеальный Образ

Цель - минимальное количество GPT-вызовов на весь сценарий.

1. Пользователь выбирает `Идеальный образ`.
2. Бот просит фото в полный рост или хотя бы по колено. Фото без видимой обуви допустимо, тогда обувь не подбирается.
3. OpenAI одним запросом проверяет фото и возвращает 3 варианта стиля.
4. Бот показывает 3 кнопки выбора стиля.
5. После выбора стиль больше не отправляется в GPT для подбора товаров: монолит локально ищет кандидатов в каталоге.
6. Для каждой категории берется до `MONOLITH_CATALOG_CANDIDATES_PER_CATEGORY` товаров.
7. Локальный скоринг выбирает лучший товар по категории, цвету, тегам, описанию и наличию `localImagePath`.
8. TryOn provider получает фото пользователя и локальные изображения выбранной одежды.
9. Бот отправляет карточки товаров с ценой, магазином, ссылкой и результат примерки.

## Словарь Категорий И Тегов

OpenAI не должен придумывать категории от себя. Перед первым GPT-вызовом бот передает компактный словарь каталога `catalogHints`:

```json
{
  "c": "брюки",
  "aliases": ["штаны", "чиносы", "pants", "trousers"],
  "n": 602,
  "colors": ["Черный", "Темно-синий"],
  "styles": [],
  "materials": [],
  "tags": ["прямой крой", "хлопок"]
}
```

Контракт:

- `category` в ответе GPT должен быть строго одним из `catalogHints.c`;
- `aliases` нужны модели для понимания синонимов, но не должны возвращаться как основная категория;
- разговорные слова вроде `штаны` и `чиносы` на стороне store приводятся к `брюки`;
- старые записи каталога нормализуются при загрузке, поэтому неверные категории из cache постепенно перестают мешать;
- для обычного публичного образа prompt запрещает выбирать белье, носки, пижаму, халат и плавки, если пользователь явно этого не просит.

Канонизация живет в `catalog/store.ts`. Если добавляете новую категорию, добавьте ее туда же:

1. canonical name в `categoryAliasesByCanonical`;
2. aliases на русском и английском;
3. правило в `categoryInferenceRules`, если категория должна определяться из slug/title старых товаров;
4. при необходимости запрет или ограничение в prompt `providers/openaiVision.ts`.

## Локальный Каталог

Карточка товара хранится как `GarmentCatalogItem`:

```ts
{
  id: "tsum:123456",
  provider: "tsum",
  externalId: "123456",
  productUrl: "https://www.tsum.ru/product/.../",
  title: "Брюки",
  category: "брюки",
  gender: "male",
  genderLabel: "Мужское",
  brand: "Brand",
  store: "ЦУМ",
  price: 59950,
  currency: "RUB",
  imageUrl: "https://...",
  imageFilename: "123456.jpg",
  localImagePath: "catalog-image/2026-08-30/123456.jpg",
  tags: ["цум", "мужское", "брюки", "Темно-синий"],
  colorTags: ["Темно-синий"],
  styleTags: [],
  materialTags: [],
  metadata: { categorySlug: "bryuki-18784" },
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z"
}
```

Для корректной работы TryOn важно:

- `productUrl` должен вести на реальную карточку товара;
- `localImagePath` должен указывать на скачанную картинку внутри `.monolith-data/`;
- `category` должен быть каноническим;
- `colorTags`, `styleTags`, `materialTags` и `tags` должны быть короткими и полезными для поиска;
- один образ не должен содержать два одинаковых типа вещи.

## Парсинг TSUM

Мужской каталог TSUM:

```env
MONOLITH_CATALOG_TSUM_MALE_URLS=https://www.tsum.ru/catalog/odezhda-2409/
```

Женские каталоги:

```env
MONOLITH_CATALOG_TSUM_FEMALE_URLS=https://www.tsum.ru/catalog/odezhda-18413/
```

Generic URL-ы, если пол/сегмент не указан явно:

```env
MONOLITH_CATALOG_TSUM_URLS=https://www.tsum.ru/catalog/example/
MONOLITH_CATALOG_TSUM_DEFAULT_GENDER=unisex
```

TSUM parser читает `__INITIAL_STATE__`, достает товары, `pageCount`, категорию, цену, бренд, цвет и ссылки на изображения. Категория сначала определяется по slug раздела, потом по названию товара. Это важно, чтобы `Джинсовая куртка` не попадала в категорию `джинсы`.

### Быстрый Refresh

```bash
npm run dev:catalog
```

Для короткого теста без обхода всех страниц:

```powershell
$env:MONOLITH_CATALOG_TSUM_MAX_PAGES="2"
$env:MONOLITH_CATALOG_BATCH_SIZE="20"
npm run dev:catalog
Remove-Item Env:MONOLITH_CATALOG_TSUM_MAX_PAGES
Remove-Item Env:MONOLITH_CATALOG_BATCH_SIZE
```

### Медленный Полный Сбор

```bash
npm run ingest:tsum:male
```

Команда идет по страницам последовательно, после каждой страницы:

- добавляет товары в `.monolith-data/catalog/items.json`;
- скачивает картинки в `.monolith-data/catalog-image/`;
- обновляет checkpoint;
- делает паузы, чтобы не долбить сайт слишком резко.

Если процесс остановить, следующий запуск продолжит с checkpoint. Если нужно начать сначала, установите:

```env
MONOLITH_TSUM_SLOW_RESET=true
```

Спокойные значения по умолчанию:

- `MONOLITH_TSUM_SLOW_PAGE_DELAY_MS=2500` - пауза между страницами;
- `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_CONCURRENCY=1` - картинки качаются по одной;
- `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_DELAY_MS=250` - пауза между скачиваниями;
- `MONOLITH_TSUM_SLOW_PAGE_RETRY_ATTEMPTS=5` - retry чтения страницы;
- `MONOLITH_TSUM_SLOW_RETRY_DELAY_MS=10000` - базовая задержка retry;
- `MONOLITH_TSUM_SLOW_MAX_PAGES=0` - собрать все страницы из `pageCount`.

Тест slow-команды на двух страницах с отдельным checkpoint:

```powershell
$env:MONOLITH_TSUM_SLOW_MAX_PAGES="2"
$env:MONOLITH_TSUM_SLOW_BATCH_SIZE="20"
$env:MONOLITH_TSUM_SLOW_CHECKPOINT_PATH=".monolith-data/catalog/test-tsum-male-checkpoint.json"
npm run ingest:tsum:male
Remove-Item Env:MONOLITH_TSUM_SLOW_MAX_PAGES
Remove-Item Env:MONOLITH_TSUM_SLOW_BATCH_SIZE
Remove-Item Env:MONOLITH_TSUM_SLOW_CHECKPOINT_PATH
```

## Env Настройки

### Runtime

- `LOG_LEVEL` - `debug`, `info`, `warn`, `error`.
- `MONOLITH_STORAGE_ROOT` - runtime-папка данных.
- `MONOLITH_MAX_DOWNLOAD_BYTES` - лимит скачиваемого файла.
- `MONOLITH_HTTP_TIMEOUT_MS` - timeout HTTP-вызовов.
- `MOCK_PROCESSING_DELAY_MS` - задержка mock TryOn.

### Telegram

- `TELEGRAM_BOT_TOKEN` - токен от BotFather.
- `TELEGRAM_POLLING_TIMEOUT_SECONDS` - long polling timeout.

### OpenAI

- `OPENAI_API_KEY` - ключ OpenAI API.
- `OPENAI_API_BASE_URL` - base URL API.
- `OPENAI_MODEL` - общая модель по умолчанию.
- `MONOLITH_OPENAI_MODEL` - модель именно для монолита.
- `OPENAI_IMAGE_DETAIL` - `low`, `auto`, `high`.
- `OPENAI_TEXT_VERBOSITY` - `low`, `medium`, `high`.
- `OPENAI_REASONING_EFFORT` - `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- `OPENAI_REASONING_MODE` - reasoning mode Responses API.
- `MONOLITH_OPENAI_MAX_OUTPUT_TOKENS` - лимит ответа анализа внешности.
- `OPENAI_STORE_RESPONSE` - сохранять response на стороне OpenAI.
- `OPENAI_ORGANIZATION` - опциональная organization.
- `OPENAI_PROJECT` - опциональный project id.
- `OPENAI_SYSTEM_PROMPT` - override системного prompt анализа внешности.

### TryOn

- `MONOLITH_TRYON_PROVIDER` - `mock` или `pruna`.
- `PRUNA_API_KEY` - ключ Pruna, если используется `pruna`.
- `PRUNA_API_BASE_URL` - base URL Pruna.
- `PRUNA_MODEL` - модель virtual try-on.
- `PRUNA_PREDICTION_PATH_TEMPLATE` - polling path template.
- `PRUNA_OUTPUT_FORMAT` - формат результата.
- `PRUNA_OUTPUT_QUALITY` - качество, если API поддерживает.
- `PRUNA_PRESERVE_INPUT_SIZE` - сохранять размер входного фото.
- `PRUNA_PROMPT` - дополнительный prompt.
- `PRUNA_SEED` - seed, если API поддерживает.
- `PRUNA_TURBO` - turbo режим, если API поддерживает.

### Catalog

- `MONOLITH_CATALOG_ENABLED` - включает сценарий каталога.
- `MONOLITH_CATALOG_REFRESH_ON_START` - обновлять каталог при старте бота.
- `MONOLITH_CATALOG_PROVIDERS` - список provider-ов, сейчас `tsum`.
- `MONOLITH_CATALOG_TSUM_MALE_URLS` - мужские TSUM URL-ы.
- `MONOLITH_CATALOG_TSUM_FEMALE_URLS` - женские TSUM URL-ы.
- `MONOLITH_CATALOG_TSUM_URLS` - generic TSUM URL-ы.
- `MONOLITH_CATALOG_TSUM_DEFAULT_GENDER` - `male`, `female`, `unisex` для generic URL-ов.
- `MONOLITH_CATALOG_TSUM_MAX_PAGES` - лимит страниц, `0` значит все.
- `MONOLITH_CATALOG_TSUM_PAGE_DELAY_MS` - пауза между страницами.
- `MONOLITH_CATALOG_TSUM_PAGE_RETRY_ATTEMPTS` - retry чтения страницы.
- `MONOLITH_CATALOG_TSUM_RETRY_DELAY_MS` - задержка retry.
- `MONOLITH_CATALOG_TSUM_PROGRESS_EVERY_PAGES` - частота progress logs.
- `MONOLITH_CATALOG_BATCH_SIZE` - лимит товаров, `0` значит без лимита.
- `MONOLITH_CATALOG_DOWNLOAD_IMAGES_ON_REFRESH` - скачивать картинки при refresh.
- `MONOLITH_CATALOG_IMAGE_DOWNLOAD_CONCURRENCY` - параллельность скачивания.
- `MONOLITH_CATALOG_IMAGE_DOWNLOAD_DELAY_MS` - пауза между скачиваниями.
- `MONOLITH_CATALOG_CANDIDATES_PER_CATEGORY` - сколько кандидатов брать на категорию.
- `MONOLITH_CATALOG_CACHE_PATH` - путь к JSON-каталогу.
- `MONOLITH_CATALOG_BROWSER_HEADLESS` - headless Chromium.
- `MONOLITH_CATALOG_BROWSER_TIMEOUT_MS` - timeout Playwright.
- `MONOLITH_CATALOG_BROWSER_WAIT_UNTIL` - `load`, `domcontentloaded`, `networkidle`.
- `MONOLITH_CATALOG_USER_AGENT` - User-Agent для каталога и картинок.

### Slow TSUM Ingest

- `MONOLITH_TSUM_SLOW_MALE_URLS` - URL-ы мужского TSUM для slow ingest.
- `MONOLITH_TSUM_SLOW_MAX_PAGES` - лимит страниц, `0` значит все.
- `MONOLITH_TSUM_SLOW_BATCH_SIZE` - лимит товаров, `0` значит без лимита.
- `MONOLITH_TSUM_SLOW_PAGE_DELAY_MS` - пауза между страницами.
- `MONOLITH_TSUM_SLOW_PAGE_RETRY_ATTEMPTS` - retry чтения страницы.
- `MONOLITH_TSUM_SLOW_RETRY_DELAY_MS` - базовая задержка retry.
- `MONOLITH_TSUM_SLOW_PROGRESS_EVERY_PAGES` - частота progress logs.
- `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_CONCURRENCY` - параллельность скачивания картинок.
- `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_DELAY_MS` - пауза между картинками.
- `MONOLITH_TSUM_SLOW_CHECKPOINT_PATH` - путь к checkpoint.
- `MONOLITH_TSUM_SLOW_RESET` - сбросить checkpoint.

## Диагностика

### Проверить Размер Каталога

```powershell
cd monolith
node --input-type=module -e "import { loadMonolithConfig } from './dist/config.js'; import { LocalCatalogStore } from './dist/catalog/store.js'; const cfg=loadMonolithConfig({requireTelegramToken:false}); const store=new LocalCatalogStore(cfg); await store.load(); console.log(store.list().length); console.log(store.categories().sort());"
```

### Проверить Подбор Брюк

```powershell
cd monolith
node --input-type=module -e "import { loadMonolithConfig } from './dist/config.js'; import { LocalCatalogStore } from './dist/catalog/store.js'; const cfg=loadMonolithConfig({requireTelegramToken:false}); const store=new LocalCatalogStore(cfg); await store.load(); console.log(store.findCandidates({category:'штаны',query:'темно-синие прямые штаны',color:'темно-синий',requiredTags:['штаны','темно-синий'],preferredTags:['прямой крой'],avoidTags:[]},5).map(i=>({title:i.title,category:i.category,colors:i.colorTags,local:Boolean(i.localImagePath)})));"
```

Ожидаемо `штаны` и `чиносы` должны приводиться к `брюки`, а `джинсы` должны находить именно джинсы, не куртки.

### Частые Проблемы

- Бот не стартует: проверьте `TELEGRAM_BOT_TOKEN` в `monolith/.env`.
- OpenAI не отвечает: проверьте `OPENAI_API_KEY`, модель и лимиты аккаунта.
- `Идеальный образ` не находит вещи: проверьте, что `.monolith-data/catalog/items.json` не пустой и у товаров есть `localImagePath`.
- TryOn не возвращает картинку: переключите `MONOLITH_TRYON_PROVIDER=mock`, чтобы отделить проблему TryOn API от логики бота.
- Playwright не открывает страницы: выполните `npm run playwright:install`.
- TSUM ingest остановился: запустите команду снова, она продолжит с checkpoint.

## Безопасность

- Не коммитьте `monolith/.env` и `.monolith-data/`.
- В `monolith/.env.example` должны быть только placeholders.
- Фото пользователей и результаты TryOn лежат локально в `.monolith-data/`, поэтому эту папку нельзя переносить в публичный репозиторий.
- Для production используйте распределенную архитектуру `apps/`, TLS, отдельное object storage, очередь, мониторинг и secret storage.

## Ограничения MVP

- Один процесс и один бот.
- Локальный JSON-каталог вместо БД.
- Локальная файловая папка вместо S3/object storage.
- Нет worker pool и распределенного scheduler-а.
- Нет административной панели каталога.
- Нет полноценного audit log и retention policy для пользовательских фото.

## Связь С Distributed Архитектурой

`monolith/` намеренно не зависит от `apps/`. Его можно менять быстро, проверять продуктовую гипотезу и переносить удачные куски в распределенную сеть позже:

- Telegram UX -> `apps/client/telegram`;
- словарь категорий и скоринг -> catalog service/storage catalog;
- OpenAI prompt -> worker model/runner;
- TryOn adapter -> `apps/worker/models`;
- локальный каталог -> object storage + catalog-ingestor.
