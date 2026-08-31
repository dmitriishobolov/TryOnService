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
| `npm run ingest:tsum:female` | Медленно и resumable собирает женский каталог TSUM. |
| `npm run ingest:tsum:all` | Последовательно собирает мужской и женский каталоги TSUM одной командой. |
| `npm run ingest:lamoda:male` | Resumable-сбор мужского каталога Lamoda с локальным сохранением изображений. |
| `npm run ingest:lamoda:female` | Resumable-сбор женского каталога Lamoda с локальным сохранением изображений. |
| `npm run ingest:lamoda:all` | Последовательно собирает мужской и женский каталоги Lamoda одной командой. |
| `npm run ingest:tsum:fast` | Быстрый all-сбор TSUM с настройками примерно под 1 час. |
| `npm run ingest:tsum:all:enrich` | Точный сбор TSUM: последовательно заходит на страницы товаров и добирает все цвета/доступные размеры. |
| `npm run playwright:install` | Устанавливает Chromium для Playwright-парсеров. |

Из корня репозитория быстрый сбор TSUM примерно под час можно запустить командой:

```bash
npm run monolith:ingest:tsum:fast
```

Обычный общий режим `npm run monolith:ingest:tsum:all` использует значения из `monolith/.env`; сейчас они тоже выставлены под fast-сбор. Отдельные сегменты из корня: `npm run monolith:ingest:tsum:male`, `npm run monolith:ingest:tsum:female`, а быстрые сегменты: `npm run monolith:ingest:tsum:male:fast` и `npm run monolith:ingest:tsum:female:fast`.

Lamoda запускается отдельно: из `monolith/` командами `npm run ingest:lamoda:male`, `npm run ingest:lamoda:female`, `npm run ingest:lamoda:all`, из корня репозитория командами `npm run monolith:ingest:lamoda:male`, `npm run monolith:ingest:lamoda:female`, `npm run monolith:ingest:lamoda:all`.
## Структура

```text
monolith/
  bot/telegramBot.ts                 # Telegram UI и пользовательские сценарии
  catalog/catalog.ts                 # Фасад локального каталога
  catalog/store.ts                   # JSON store товаров, скоринг, категории и aliases
  catalog/runIngest.ts               # Разовый refresh каталога
  catalog/runTsumSlowIngest.ts       # Медленный resumable обход TSUM: male/female/all
  catalog/runLamodaIngest.ts         # Resumable обход Lamoda: male/female/all
  catalog/runTsumMaleSlowIngest.ts   # Совместимый wrapper старой male-команды
  catalog/providers/tsum/parser.ts   # Playwright parser TSUM
  catalog/providers/lamoda/parser.ts # Playwright parser Lamoda with persistent browser session
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
- `.monolith-data/catalog/tsum-all-ingest-checkpoint.json` - checkpoint общего обхода мужского и женского TSUM.
- `.monolith-data/catalog/tsum-male-ingest-checkpoint.json` - checkpoint отдельного мужского обхода.
- `.monolith-data/catalog/tsum-female-ingest-checkpoint.json` - checkpoint отдельного женского обхода.
- `.monolith-data/catalog/lamoda-all-ingest-checkpoint.json` - checkpoint общего обхода мужского и женского Lamoda.
- `.monolith-data/catalog/lamoda-male-ingest-checkpoint.json` - checkpoint мужского Lamoda.
- `.monolith-data/catalog/lamoda-female-ingest-checkpoint.json` - checkpoint женского Lamoda.
- `.monolith-data/catalog-image/` - скачанные изображения товаров.

Если изображение товара не удалось скачать, товар всё равно сохраняется в `items.json`, но поле `imageFile` остается пустым. Это и есть простой маркер: карточка есть, локального файла пока нет.
- `.monolith-data/telegram-input/` - фото, полученные от пользователей Telegram.
- `.monolith-data/tryon-result/` - результаты TryOn provider-а.

Ключевое правило: бот работает с локальными изображениями товаров. В каталоге внешний `imageUrl` остается как источник, но для примерки нужен `imageFile`.

## Lamoda Parser

Lamoda provider живет в `catalog/providers/lamoda/parser.ts`. Он открывает страницу каталога через Playwright, ищет карточки товаров по ссылкам вида `/p/<sku>`, нормализует их в общий `GarmentCatalogItem` и отдаёт дальше в `MonolithCatalog`. Общий слой уже делает upsert по `id: "lamoda:<sku>"` и скачивает изображение товара в `.monolith-data/catalog-image/`.

Default-источники:

- мужской каталог: `https://www.lamoda.ru/c/477/clothes-muzhskaya-odezhda`;
- женский каталог: `https://www.lamoda.ru/c/355/clothes-zhenskaya-odezhda`.

Команды:

```bash
npm run lamoda:session
npm run lamoda:session:opera
npm run ingest:lamoda:male
npm run ingest:lamoda:male:opera
npm run ingest:lamoda:female
npm run ingest:lamoda:all
```

Если в текущем PowerShell уже выставлен старый `MONOLITH_LAMODA_BROWSER_CHANNEL=chrome`, используйте команды с суффиксом `:opera`: они передают `--browser-channel=opera` напрямую и перебивают stale env.

`npm run lamoda:session` открывает видимый браузер с тем же persistent profile, который использует parser. Для standalone Lamoda-команд можно выбрать установленную Opera через `MONOLITH_LAMODA_BROWSER_CHANNEL=opera`; если авто-поиск не найдет браузер, задайте `MONOLITH_LAMODA_BROWSER_EXECUTABLE_PATH`. В этом окне нужно вручную войти в Lamoda или пройти видимую проверку. После нажатия Enter команда проверит каталог и сохранит cookies/profile для следующих запусков ingest.

Lamoda parser работает через одну persistent Playwright-сессию: сначала открывает главную страницу Lamoda, принимает cookie banner, делает небольшой scroll и только потом идет в каталог. Переходы по следующим страницам выполняются кликом по pagination-ссылкам, если такая ссылка есть на текущей странице; прямой `goto` остается только fallback-ом для первого входа, checkpoint resume и случаев, когда ссылка на следующую страницу не найдена.

Прямой GraphQL/fetch runtime-путь для Lamoda убран. Для недостающих полей parser открывает страницу товара `/p/...` в той же browser-сессии, например `https://www.lamoda.ru/p/mp002xm0ct8s/clothes-thecave-futbolka/`. Так добираются `sizes`, `colors`, `price`, `brand`, название и более надежный `imageUrl`. Общий слой после этого делает upsert по `id: "lamoda:<sku>"` и скачивает изображение локально.

Persistent profile хранится в `.monolith-data/browser/lamoda`, поэтому cookies и ручная проверка Lamoda сохраняются между запусками. Если Lamoda показывает `403` или security page, запускайте видимый браузер через `MONOLITH_LAMODA_BROWSER_HEADLESS=false`; если bundled Chromium выглядит подозрительно для Lamoda, ставьте `MONOLITH_LAMODA_BROWSER_CHANNEL=opera`. Если авто-поиск Opera не найдет executable, задайте `MONOLITH_LAMODA_BROWSER_EXECUTABLE_PATH`.

Режим product-page enrichment:

- `off` - не открывать страницы товаров;
- `missing` - открывать только если не хватает названия, изображения, размера или цвета;
- `all` - открывать каждую карточку товара.

Для ручной проверки можно запускать с `MONOLITH_CATALOG_BROWSER_HEADLESS=false`, `MONOLITH_LAMODA_BROWSER_CHANNEL=opera` и `MONOLITH_LAMODA_SECURITY_WAIT_MS=60000`, пройти проверку в открывшемся окне и дать parser-у сделать reload. Если Lamoda отклоняет даже установленную Opera под управлением Playwright, для MVP лучше использовать ручной импорт каталога, CSV/export или другой разрешенный источник, а не строить обход антибот-защиты.

Главные env-параметры:

- `MONOLITH_CATALOG_LAMODA_MALE_URLS`, `MONOLITH_CATALOG_LAMODA_FEMALE_URLS` - источники для обычного `dev:catalog`;
- `MONOLITH_LAMODA_MALE_URLS`, `MONOLITH_LAMODA_FEMALE_URLS` - override источников для отдельной Lamoda ingest-команды;
- `MONOLITH_LAMODA_PAGE_DELAY_MS`, `MONOLITH_LAMODA_PAGE_RETRY_ATTEMPTS`, `MONOLITH_LAMODA_RETRY_DELAY_MS` - темп и retry чтения страниц;
- `MONOLITH_LAMODA_BROWSER_HEADLESS`, `MONOLITH_LAMODA_BROWSER_CHANNEL`, `MONOLITH_LAMODA_BROWSER_EXECUTABLE_PATH`, `MONOLITH_LAMODA_USER_DATA_DIR`, `MONOLITH_LAMODA_SECURITY_WAIT_MS` - browser-like режим, канал браузера, путь к Opera executable, persistent profile и ожидание ручной проверки;
- `MONOLITH_LAMODA_SESSION_URL`, `MONOLITH_LAMODA_SESSION_VERIFY_URL`, `MONOLITH_LAMODA_SESSION_KEEP_OPEN_MS` - ручная подготовка Lamoda-сессии;
- `MONOLITH_LAMODA_PRODUCT_ENRICHMENT`, `MONOLITH_LAMODA_PRODUCT_CONCURRENCY`, `MONOLITH_LAMODA_PRODUCT_PAGE_DELAY_MS` - добор размеров, цветов и лучшего изображения со страниц товаров;
- `MONOLITH_LAMODA_IMAGE_DOWNLOAD_CONCURRENCY`, `MONOLITH_LAMODA_IMAGE_DOWNLOAD_DELAY_MS` - скорость скачивания изображений;
- `MONOLITH_LAMODA_CHECKPOINT_PATH`, `MONOLITH_LAMODA_RESET` - checkpoint и ручной сброс обхода.


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

Цель - минимум GPT-вызовов и максимум локальной работы по каталогу.

1. Пользователь выбирает `Идеальный образ`.
2. Бот спрашивает пожелание к образу: случай, стиль, цвета, настроение или ограничения. Шаг можно пропустить.
3. Бот спрашивает размерный диапазон: `Любой размер`, `XS-S`, `M-L`, `XL-XXL`. На кнопках показывается количество товаров, которые подходят под этот размерный фильтр, например `M-L (128)`.
4. Бот спрашивает бюджет на одну вещь: `Любой бюджет`, `до 10 000 ₽`, `до 30 000 ₽`, `до 100 000 ₽`, `100 000 ₽+`. На этом шаге счетчики уже пересчитаны с учетом выбранного размера, например `до 30 000 ₽ (42)`.
5. Бот просит фото в полный рост или хотя бы по колено. Фото без видимой обуви допустимо, тогда обувь не подбирается.
6. OpenAI одним запросом проверяет фото и возвращает 3 варианта стиля с каноническими категориями, тегами, полом каталожного сегмента, размерным фильтром и бюджетным фильтром.
7. Если пожелание слишком экзотическое, но его можно превратить в одежду, OpenAI адаптирует его под носибельный образ и объясняет это в `summary`. Если пожелание невозможно понять как запрос на одежду, бот просит переформулировать.
8. Бот показывает 3 кнопки выбора стиля.
9. После выбора стиль больше не отправляется в GPT для подбора товаров: монолит локально ищет кандидатов в каталоге.
10. Для каждой категории берется до `MONOLITH_CATALOG_CANDIDATES_PER_CATEGORY` товаров.
11. Локальный скоринг выбирает лучший товар по категории, полу, цвету, размеру, бюджету, тегам, описанию и наличию `imageFile`.
12. TryOn-слой получает фото пользователя и локальные изображения выбранной одежды.
13. Бот отправляет результат примерки и карточки товаров с ценой, размерами, цветами и ссылкой.

Во время активного фонового процесса бот игнорирует новые команды и фото, чтобы пользователь не сбил состояние. Сообщение прогресса редактируется на месте через Telegram `editMessageText`; если Telegram не разрешил редактирование, бот пересоздает status-сообщение.

## Словарь Категорий И Тегов

OpenAI не должен придумывать категории от себя. Перед первым GPT-вызовом бот передает компактный словарь каталога `catalogHints`:

```json
{
  "c": "брюки",
  "aliases": ["штаны", "чиносы", "pants", "trousers"],
  "n": 602,
  "colors": ["Черный", "Темно-синий"],
  "tags": ["прямой крой", "хлопок"]
}
```

Контракт:

- `category` в ответе GPT должен быть строго одним из `catalogHints.c`;
- `aliases` нужны модели для понимания синонимов, но не должны возвращаться как основная категория;
- разговорные слова вроде `штаны` и `чиносы` на стороне store приводятся к `брюки`;
- `gender` в ответе GPT нужен для выбора мужского/женского/унисекс-сегмента каталога;
- `sizePreference` и `pricePreference` протаскиваются из пользовательского мастера в каждую категорию;
- старые записи каталога нормализуются при загрузке, поэтому неверные категории из cache постепенно перестают мешать;
- для обычного публичного образа prompt запрещает выбирать белье, носки, пижаму, халат и плавки, если пользователь явно этого не просит.

Канонизация живет в `catalog/store.ts`. Если добавляете новую категорию, добавьте ее туда же:

1. canonical name в `categoryAliasesByCanonical`;
2. aliases на русском и английском;
3. правило в `categoryInferenceRules`, если категория должна определяться из slug/title старых товаров;
4. при необходимости запрет или ограничение в prompt `providers/openaiVision.ts`.

## Локальный Каталог

Карточка товара хранится как компактный `GarmentCatalogItem` без сырого JSON магазина и без отдельных служебных полей provider/externalId:

```ts
{
  id: "tsum:123456",
  category: "брюки",
  gender: "male",
  title: "Брюки",
  description: "Темно-синие брюки прямого кроя",
  sizes: ["48", "50", "52"],
  colors: ["Темно-синий"],
  price: {
    amount: 59950,
    currency: "RUB",
    oldAmount: 79950
  },
  tags: ["цум", "брюки", "темно-синий", "шерсть", "прямой крой"],
  productUrl: "https://www.tsum.ru/product/.../",
  imageUrl: "https://...",
  imageFile: "catalog-image/2026-08-31/123456.jpg",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z"
}
```

Поля:

- `id` - стабильный ключ товара. Для TSUM используется формат `tsum:<externalId>`, поэтому отдельные `provider` и `externalId` в карточке не нужны.
- `category` - каноническая категория из словаря `catalog/store.ts`.
- `gender` - сегмент каталога: `male`, `female` или `unisex`.
- `title` и `description` - короткое название и описание товара.
- `sizes` и `colors` - доступные размеры и цвета, если parser смог их вытащить.
- `price` - актуальная цена с валютой, `oldAmount` опционален для старой цены/скидки.
- `tags` - единый набор поисковых тегов: категория, цвет, материал, крой, сезонность, бренд/магазин как текстовый признак, если parser их знает.
- `productUrl` - ссылка на карточку товара.
- `imageUrl` - внешняя ссылка на изображение товара.
- `imageFile` - локальный файл внутри `.monolith-data/`. Если поля нет, локальная картинка не скачалась или еще не подготовлена.

Для корректной работы примерки важно:

- `productUrl` должен вести на реальную карточку товара;
- `imageFile` должен указывать на скачанную картинку внутри `.monolith-data/`;
- `category` должен быть каноническим;
- `colors` и `tags` должны быть короткими и полезными для поиска;
- один образ не должен содержать два одинаковых типа вещи;
- `sizes` и `price` используются как мягкие фильтры: точное совпадение поднимает товар, явное несовпадение снижает score, но не ломает сценарий при неполных данных магазина. Счетчики на кнопках считают товары с `productUrl` и доступным `imageFile` или `imageUrl`; для конкретного размера/бюджета учитываются только известные совпадения.

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

TSUM parser читает `__INITIAL_STATE__` и сразу приводит товар к новой компактной таблице `GarmentCatalogItem`: `id`, `category`, `gender`, `title`, `description`, `sizes`, `colors`, `price`, `tags`, `productUrl`, `imageUrl`, `imageFile`, `createdAt`, `updatedAt`. Быстрый режим берет данные из листинга каталога: `pageCount`, бренд, основной цвет, цену и ссылки на изображения. Для размеров и полного списка цветов есть product-page enrichment: parser заходит в `state.product.product.<slug>.product`, берет доступные размеры из `offers[*].size` и цвета из `products[*].color`. Если внешняя картинка не найдена или не скачалась, товар все равно сохраняется, `imageUrl` может быть пустым, а `imageFile` остается пустым маркером. Категория определяется по slug, названию, alt-тексту и тегам. Это важно, чтобы `Джинсовая куртка` не попадала в категорию `джинсы`.

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

### Быстрый и Полный Сбор TSUM

```bash
npm run ingest:tsum:fast
```

Команда `ingest:tsum:fast` последовательно проходит мужской каталог `https://www.tsum.ru/catalog/odezhda-2409/`, затем женский каталог `https://www.tsum.ru/catalog/odezhda-18413/`. Это один процесс с checkpoint по каждому источнику, поэтому его можно останавливать и запускать снова.

Для более бережного режима сначала выставьте `MONOLITH_TSUM_SLOW_PROFILE=safe`, `MONOLITH_TSUM_SLOW_PAGE_DELAY_MS=2500`, `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_CONCURRENCY=4`, `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_DELAY_MS=250`, затем запускайте `npm run ingest:tsum:all`.

Если нужны все доступные размеры и все цвета с карточек товаров, запускайте `npm run ingest:tsum:all:enrich` из `monolith/` или `npm run monolith:ingest:tsum:all:enrich` из корня. Этот режим снова открывает страницы товаров последовательно: npm-команды `*:enrich` передают `--product-concurrency=1`, а задержка между переходами задается `MONOLITH_TSUM_SLOW_PRODUCT_PAGE_DELAY_MS`. Для точечного теста можно включить `MONOLITH_TSUM_SLOW_PRODUCT_ENRICHMENT=all` вместе с `MONOLITH_TSUM_SLOW_MAX_PAGES=1`.

Для отдельного сегмента доступны команды:

```bash
npm run ingest:tsum:male
npm run ingest:tsum:female
npm run ingest:tsum:male:fast
npm run ingest:tsum:female:fast
npm run ingest:tsum:male:enrich
npm run ingest:tsum:female:enrich
```

После каждой страницы команда:

- добавляет найденные товары в `.monolith-data/catalog/items.json`;
- скачивает картинки в `.monolith-data/catalog-image/`;
- оставляет `imageFile` пустым у товаров, где локальная картинка не скачалась;
- обновляет checkpoint;
- делает паузы между страницами по текущему профилю.

Если чтение страницы временно ломается, runner делает retry. Если страница так и не прочиталась, процесс останавливается без пропуска страницы. Следующий запуск продолжит с последней полностью сохранённой страницы.

Если нужно начать сначала, установите:

```env
MONOLITH_TSUM_SLOW_RESET=true
```

Текущие быстрые значения в `monolith/.env.example` и локальном `monolith/.env`:

- `MONOLITH_TSUM_SLOW_MODE=all` - режим `male`, `female` или `all`;
- `MONOLITH_TSUM_SLOW_PROFILE=fast` - быстрый профиль;
- `MONOLITH_TSUM_SLOW_PAGE_DELAY_MS=2000` - пауза 2 секунды между страницами;
- `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_CONCURRENCY=24` - до 24 картинок параллельно;
- `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_DELAY_MS=0` - без искусственной паузы между картинками;
- `MONOLITH_TSUM_SLOW_PAGE_RETRY_ATTEMPTS=5` - retry чтения страницы;
- `MONOLITH_TSUM_SLOW_RETRY_DELAY_MS=5000` - базовая задержка retry;
- `MONOLITH_TSUM_SLOW_MAX_PAGES=0` - собрать все страницы из `pageCount`.

Если TSUM начнёт часто отвечать ошибками или резко замедлится, переключите `MONOLITH_TSUM_SLOW_PROFILE=safe`, поднимите `MONOLITH_TSUM_SLOW_PAGE_DELAY_MS` до `1500-2500` и снизьте `MONOLITH_TSUM_SLOW_IMAGE_DOWNLOAD_CONCURRENCY` до `4-8`.

Тест fast-команды на двух страницах с отдельным checkpoint:

```powershell
$env:MONOLITH_TSUM_SLOW_MAX_PAGES="2"
$env:MONOLITH_TSUM_SLOW_BATCH_SIZE="20"
$env:MONOLITH_TSUM_SLOW_CHECKPOINT_PATH=".monolith-data/catalog/test-tsum-fast-checkpoint.json"
npm run ingest:tsum:fast
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
- `MONOLITH_CATALOG_TSUM_PRODUCT_ENRICHMENT` - `off`, `missing` или `all`; управляет чтением страниц конкретных товаров ради размеров и всех цветов.
- `MONOLITH_CATALOG_TSUM_PRODUCT_CONCURRENCY` - параллельность product-page enrichment при обычном refresh.
- `MONOLITH_CATALOG_TSUM_PRODUCT_PAGE_DELAY_MS` - пауза между product-page переходами одного worker-а.
- `MONOLITH_CATALOG_TSUM_PRODUCT_PAGE_TIMEOUT_MS` - timeout чтения одной страницы товара.
- `MONOLITH_CATALOG_TSUM_PRODUCT_PAGE_RETRY_ATTEMPTS` - retry чтения product page.
- `MONOLITH_CATALOG_TSUM_PRODUCT_RETRY_DELAY_MS` - задержка retry product page.
- `MONOLITH_TSUM_SLOW_PRODUCT_CONCURRENCY` - параллельность чтения product pages в slow/enrich-командах; `*:enrich` сейчас запускается с 1, чтобы не ловить бан из-за всплеска запросов.
- `MONOLITH_TSUM_SLOW_PRODUCT_PAGE_TIMEOUT_MS` - отдельный timeout product page для slow/enrich-сбора; помогает не зависать на тяжёлых карточках.
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

- `MONOLITH_TSUM_SLOW_MODE` - режим slow-сбора: `male`, `female` или `all`.
- `MONOLITH_TSUM_SLOW_MALE_URLS` - URL-ы мужского TSUM для slow ingest.
- `MONOLITH_TSUM_SLOW_FEMALE_URLS` - URL-ы женского TSUM для slow ingest.
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
node --input-type=module -e "import { loadMonolithConfig } from './dist/config.js'; import { LocalCatalogStore } from './dist/catalog/store.js'; const cfg=loadMonolithConfig({requireTelegramToken:false}); const store=new LocalCatalogStore(cfg); await store.load(); console.log(store.findCandidates({category:'штаны',query:'темно-синие прямые штаны',color:'темно-синий',requiredTags:['штаны','темно-синий'],preferredTags:['прямой крой'],avoidTags:[]},5).map(i=>({title:i.title,category:i.category,colors:i.colors,local:Boolean(i.imageFile)})));"
```

Ожидаемо `штаны` и `чиносы` должны приводиться к `брюки`, а `джинсы` должны находить именно джинсы, не куртки.

### Частые Проблемы

- Бот не стартует: проверьте `TELEGRAM_BOT_TOKEN` в `monolith/.env`.
- OpenAI не отвечает: проверьте `OPENAI_API_KEY`, модель и лимиты аккаунта.
- `Идеальный образ` не находит вещи: проверьте, что `.monolith-data/catalog/items.json` не пустой, у товаров есть `imageFile`, а нужный пол/категория/размер/бюджет реально представлены в каталоге.
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
