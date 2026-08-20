# Инструкция по добавлению нового клиента

Клиент TryOnService - это отдельная интеграция, через которую конечный пользователь или внешняя система создает job и получает результат. Это может быть Telegram bot, Discord bot, backend сайта, мобильный backend, CRM-интеграция или любой другой сервисный вход.

Главное правило: клиент не обрабатывает AI-задачу сам и не гоняет файлы через coordinator. Он принимает пользовательский запрос, загружает файлы напрямую в object storage, получает у coordinator подходящий worker и отправляет heavy request worker-у напрямую.

## Когда нужен новый клиент

Создавайте новый клиент, если появляется новый канал входа:

- сайт или web app;
- Discord bot;
- мобильное приложение с backend-сервисом;
- отдельный B2B API для клиента;
- интеграция с CRM, маркетплейсом или внутренней системой заказчика.

Если меняется только AI-пайплайн, новый клиент обычно не нужен. В этом случае меняйте `apps/worker/runner` и `apps/worker/models`.

## Общий поток клиента

1. Клиент стартует, выбирает свободный callback-порт и регистрируется в coordinator через `POST /clients/register` с `x-client-key: CLIENT_REGISTRATION_KEY`.
2. Coordinator сохраняет `clientId`, `type`, public callback URL и ждет heartbeat.
3. Клиент каждые `CLIENT_HEARTBEAT_INTERVAL_MS` отправляет `POST /clients/:clientId/heartbeat`.
4. Пользователь создает запрос в своем канале: сайт, Discord, Telegram или другой источник.
5. Если есть файлы, клиент запрашивает `POST /storage/access`, загружает файлы напрямую в storage-node и получает `StorageObjectRef`.
6. Клиент создает job через `POST /jobs`, передавая `sourceClientId`, `client` metadata и payload.
7. Coordinator либо сразу возвращает assignment, либо отвечает `202 queued`; в этом случае клиент polling-ом вызывает `GET /jobs/:jobId/assignment`.
8. Coordinator выбирает worker, готовит pending assignment на worker-е и возвращает клиенту `worker.jobUrl`, `worker.dispatchToken` и `workerRequest`.
9. Клиент отправляет `workerRequest` напрямую в worker с header `x-job-dispatch-token`.
10. Worker обрабатывает задачу и отправляет результат на callback URL клиента с header `x-client-callback-token`.
11. Клиент проверяет callback token, связывает `jobId` со своим пользователем/каналом и показывает результат.

Coordinator остается control-plane: registry, assignment, security, metadata. Файлы и результат job идут по data-plane напрямую: client -> storage/worker -> client.

## Минимальная структура папки

Новый клиент размещайте в `apps/client/<client-name>`.

```text
apps/client/<client-name>/
  README.md
  config.ts
  coordinatorClient.ts
  workerClient.ts
  callbackServer.ts
  index.ts
  <platform>.ts
```

Роли файлов:

- `README.md` - как запустить интеграцию, какие env нужны, какой пользовательский поток реализован.
- `config.ts` - чтение env, defaults, валидация портов, URL и секретов.
- `coordinatorClient.ts` - регистрация клиента, heartbeat, `POST /storage/access`, `POST /jobs`, polling `GET /jobs/:jobId/assignment`.
- `workerClient.ts` - прямой `POST` на `assignment.worker.jobUrl` с `x-job-dispatch-token`.
- `callbackServer.ts` - HTTP callback endpoint, проверка `x-client-callback-token`, replay guard по `tokenId`.
- `index.ts` - старт callback server, регистрация в coordinator, запуск heartbeat и платформенного клиента.
- `<platform>.ts` - код канала: Discord bot, website HTTP server, webhook adapter и так далее.

Для небольшого клиента часть файлов можно объединить, но границы ответственности лучше сохранить. Telegram client в `apps/client/telegram` можно использовать как рабочий пример.

## Шаг 1. Расширьте shared contracts

Сейчас реализован только `ClientType = "telegram"`. Для website, Discord и следующих интеграций первым делом расширяйте `apps/shared/contracts/index.ts`.

Добавьте новый тип клиента:

```ts
export type ClientType = "telegram" | "discord" | "website";
```

Добавьте metadata, по которой callback сможет понять, кому вернуть результат:

```ts
export interface DiscordClientRef {
  type: "discord";
  guildId?: string;
  channelId: string;
  userId: string;
  messageId?: string;
}

export interface WebsiteClientRef {
  type: "website";
  userId: string;
  requestId: string;
  sessionId?: string;
}

export type ClientRef =
  | TelegramClientRef
  | DiscordClientRef
  | WebsiteClientRef;
```

Обновите runtime validators в том же файле:

- `isClientRegistrationRequest` должен принимать новый `type`;
- `isCreateTryOnJobRequest` должен валидировать новый `ClientRef`;
- `isWorkerJobRequest` и `isWorkerAssignmentPrepareRequest` должны принимать новый `ClientRef`;
- callback validator должен стать общим или получить отдельную проверку для нового клиента.

Важно: worker сейчас отправляет `TelegramJobCallbackRequest`, а некоторые проверки сравнивают telegram-specific поля вроде `chatId`. Перед добавлением не-Telegram клиента вынесите проверку `ClientRef` в общий helper и сравнивайте client metadata по типу клиента.

## Шаг 2. Добавьте конфигурацию

Каждый клиент должен иметь свой `clientId`, порт callback server и public endpoint.

Общие env для всех клиентов:

```dotenv
COORDINATOR_URL=http://localhost:3000
CLIENT_REGISTRATION_KEY=dev-client-registration-key
CLIENT_CALLBACK_SIGNING_KEY=dev-client-callback-signing-key
CLIENT_CALLBACK_SIGNING_KEY_VERSION=dev-v1
CLIENT_HEARTBEAT_INTERVAL_MS=5000
API_RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT_MAX_REQUESTS=120
HTTP_CLIENT_TIMEOUT_MS=5000
HTTP_CLIENT_RETRIES=2
MAX_JSON_BODY_BYTES=1048576
```

Клиентские env называйте с префиксом интеграции:

```dotenv
DISCORD_CLIENT_ID=discord-client-dev
DISCORD_CLIENT_PORT=4110
DISCORD_CLIENT_PUBLIC_PROTOCOL=http
DISCORD_CLIENT_PUBLIC_URL=
DISCORD_BOT_TOKEN=
```

```dotenv
WEBSITE_CLIENT_ID=website-client-dev
WEBSITE_CLIENT_PORT=4120
WEBSITE_CLIENT_PUBLIC_PROTOCOL=http
WEBSITE_CLIENT_PUBLIC_URL=
WEBSITE_SESSION_SECRET=
```

Если `*_CLIENT_PUBLIC_URL` не задан, клиент должен передать coordinator фактический порт и `*_CLIENT_PUBLIC_PROTOCOL`. Coordinator соберет public base URL из IP registration-запроса и порта, а затем добавит `callbackPath`. Если клиент находится за NAT, reverse proxy или доменом, задавайте `*_CLIENT_PUBLIC_URL` явно как base URL callback server-а.

Добавьте новые env в `.env.example` с русскими комментариями и в `scripts/build-dist.mjs`, если клиент должен попадать в deploy-пакет.

## Шаг 3. Зарегистрируйте client service

На старте клиент поднимает callback server, выбирает свободный порт и регистрируется в coordinator.

Запрос:

```http
POST /clients/register
x-client-key: <CLIENT_REGISTRATION_KEY>
content-type: application/json
```

Тело:

```json
{
  "clientId": "discord-client-dev",
  "type": "discord",
  "port": 4110,
  "publicProtocol": "http",
  "callbackPath": "/callbacks/jobs"
}
```

Если есть ручной public URL:

```json
{
  "clientId": "website-client-dev",
  "type": "website",
  "port": 4120,
  "publicUrl": "https://tryon.example.com/website-client",
  "callbackPath": "/callbacks/jobs"
}
```

В этом примере итоговый trusted callback URL будет `https://tryon.example.com/website-client/callbacks/jobs`. После успешной регистрации coordinator вернет `callbackUrl` и `heartbeatIntervalMs`. Клиент должен логировать эти значения при старте, чтобы деплой было легко проверить.

## Шаг 4. Отправляйте heartbeat

Heartbeat нужен coordinator-у, чтобы не выдавать jobs клиенту, который уже не может принять callback.

Запрос:

```http
POST /clients/<clientId>/heartbeat
x-client-key: <CLIENT_REGISTRATION_KEY>
content-type: application/json
```

Тело:

```json
{
  "clientId": "discord-client-dev",
  "status": "ready"
}
```

Если клиент падает или перестает отправлять heartbeat, coordinator пометит его offline и попробует отменить pending/running job на worker-е. При подтвержденной отмене job станет `cancelled`, иначе coordinator не освободит capacity до финального отчета worker-а.

## Шаг 5. Работайте с файлами через storage-node

Клиент не должен отправлять изображения в coordinator. Для входных файлов:

1. Создайте `requestId` на стороне клиента.
2. Запросите storage access у coordinator.
3. Загрузите файлы напрямую в `storage.objectBaseUrl`.
4. Передайте в `POST /jobs` только `StorageObjectRef`.

Запрос storage access:

```json
{
  "requesterId": "discord-client-dev",
  "requesterType": "client",
  "scope": "read-write",
  "keyPrefix": "clients/discord-client-dev/input/<requestId>"
}
```

Object key должен быть внутри namespace клиента:

```text
clients/<clientId>/input/<requestId>/<fileName>
```

Coordinator не выдаст клиенту доступ за пределы `clients/<clientId>`. Для нескольких входных файлов используйте один storage-node и общий prefix, иначе coordinator не сможет выдать worker-у компактный read-only token.

## Шаг 6. Создайте job assignment

Клиент запрашивает job/assignment в coordinator. Payload должен быть легким: текст, параметры, ссылки на storage objects.

```http
POST /jobs
x-client-key: <CLIENT_REGISTRATION_KEY>
content-type: application/json
```

Пример для Discord:

```json
{
  "sourceClientId": "discord-client-dev",
  "client": {
    "type": "discord",
    "guildId": "123",
    "channelId": "456",
    "userId": "789",
    "messageId": "101112"
  },
  "payload": {
    "command": "request",
    "text": "try this outfit",
    "inputFiles": [
      {
        "driver": "local",
        "storageId": "storage-dev",
        "key": "clients/discord-client-dev/input/req-1/person.jpg",
        "contentType": "image/jpeg",
        "sizeBytes": 123456
      }
    ]
  }
}
```

Пример для website:

```json
{
  "sourceClientId": "website-client-dev",
  "client": {
    "type": "website",
    "userId": "user-42",
    "requestId": "req-1",
    "sessionId": "session-abc"
  },
  "payload": {
    "command": "request",
    "inputFiles": [
      {
        "driver": "local",
        "storageId": "storage-dev",
        "key": "clients/website-client-dev/input/req-1/person.jpg"
      }
    ]
  }
}
```

Coordinator сам подставит trusted callback URL из registry по `sourceClientId`. Не передавайте callback URL от пользователя как источник доверия.

Если coordinator вернул `202`, job поставлена в очередь:

```json
{
  "queued": true,
  "retryAfterMs": 1000,
  "reason": "no_available_worker",
  "job": {
    "id": "..."
  }
}
```

После такого ответа клиент должен polling-ом ждать assignment:

```http
GET /jobs/<jobId>/assignment?sourceClientId=<clientId>
x-client-key: <CLIENT_REGISTRATION_KEY>
```

Пока capacity нет, endpoint снова вернет `202 queued`; когда worker выбран и prepared, вернет обычный assignment.

## Шаг 7. Отправьте job напрямую worker-у

Coordinator вернет:

- `job` - metadata созданной job;
- `worker.jobUrl` - endpoint выбранного worker-а;
- `worker.dispatchToken` - signed token для этой job и этого worker-а;
- `workerRequest` - тело запроса, которое надо отправить worker-у;
- `storage` - storage access для worker-а, если он нужен.

Клиент отправляет:

```http
POST <assignment.worker.jobUrl>
x-job-dispatch-token: <assignment.worker.dispatchToken>
content-type: application/json
```

Тело запроса: `assignment.workerRequest`.

Не изменяйте `workerRequest` после ответа coordinator. Worker сверяет job с подготовленным assignment и отклонит неожиданные данные.

## Шаг 8. Примите callback результата

Callback endpoint клиента принимает результат от worker-а.

```http
POST /callbacks/jobs
x-client-callback-token: <signed callback token>
content-type: application/json
```

Клиент обязан:

- проверить подпись токена через `CLIENT_CALLBACK_SIGNING_KEY`;
- проверить `CLIENT_CALLBACK_SIGNING_KEY_VERSION`;
- проверить purpose `client-callback`;
- отклонить истекший token;
- защититься от replay по `tokenId`;
- убедиться, что `jobId` и `client` в callback соответствуют ожидаемому запросу;
- отправить результат пользователю в своем канале.

Replay guard может быть in-memory для dev. Для production клиента лучше хранить использованные `tokenId` в Redis/Postgres с TTL до `expiresAt`.

## Website client

Для сайта клиентом должен быть backend сайта, а не браузер.

Backend сайта:

- хранит `CLIENT_REGISTRATION_KEY`, `CLIENT_CALLBACK_SIGNING_KEY` и platform/session secrets;
- регистрируется в coordinator и отправляет heartbeat;
- принимает upload от браузера или выдает браузеру свой upload flow;
- получает storage access у coordinator и загружает файлы напрямую в storage-node;
- создает job assignment, обрабатывает queued-ответ и отправляет `workerRequest` worker-у;
- принимает callback от worker-а и обновляет состояние заявки пользователя;
- отдает браузеру статус через polling, SSE, WebSocket или собственный API.

Браузер не должен получать `CLIENT_REGISTRATION_KEY`, callback signing key, worker service keys или прямой доступ к coordinator admin API. Если нужен прямой browser upload в storage, backend сайта должен выдать ограниченный одноразовый upload-flow только для конкретного пользователя и object key.

## Discord bot client

Discord bot работает по той же схеме, что Telegram client:

- bot token хранится только в env Discord клиента;
- slash command или button создает `requestId`;
- attachments скачиваются bot-процессом или прямым backend-потоком и загружаются в storage-node;
- `client` metadata должен содержать минимум `channelId` и `userId`, чтобы callback знал куда отправить результат;
- после `POST /jobs` бот может сразу ответить пользователю статусом `accepted` или `queued`;
- callback от worker-а редактирует исходное сообщение или отправляет новое сообщение в канал.

Не кладите Discord-specific поля в worker runner. Runner должен работать с общим `ClientRef` только как с metadata для callback.

## Сборка и запуск

Для нового клиента добавьте scripts в `package.json`:

```json
{
  "dev:discord": "tsx apps/client/discord/index.ts",
  "start:discord": "node dist/apps/client/discord/index.js"
}
```

Если клиент должен поставляться как готовый deploy-пакет, добавьте service entry в `scripts/build-dist.mjs`:

```js
{
  name: "discord-client",
  title: "TryOnService Discord Client",
  entry: "app/apps/client/discord/index.js",
  directories: ["client", "shared"],
  envKeys: [
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_PORT",
    "DISCORD_CLIENT_PUBLIC_PROTOCOL",
    "DISCORD_CLIENT_PUBLIC_URL",
    "DISCORD_BOT_TOKEN",
    "COORDINATOR_URL",
    "CLIENT_REGISTRATION_KEY",
    "CLIENT_CALLBACK_SIGNING_KEY",
    "CLIENT_CALLBACK_SIGNING_KEY_VERSION",
    "CLIENT_HEARTBEAT_INTERVAL_MS",
    "API_RATE_LIMIT_WINDOW_MS",
    "API_RATE_LIMIT_MAX_REQUESTS",
    "HTTP_CLIENT_TIMEOUT_MS",
    "HTTP_CLIENT_RETRIES",
    "MAX_JSON_BODY_BYTES"
  ]
}
```

После этого `npm run build:dist` должен создать `dist/packages/<client-name>-client`.

## Security checklist

Перед merge нового клиента проверьте:

- registration и heartbeat используют только `CLIENT_REGISTRATION_KEY`;
- platform token не попал в git, README или логи;
- callback token проверяется до обработки callback как trusted результата;
- replay по `tokenId` отклоняется;
- object keys лежат только под `clients/<clientId>/...`;
- большие файлы не идут через coordinator;
- браузерный frontend не знает сервисные ключи;
- ошибки external platform API не ломают heartbeat и callback server;
- клиент умеет пережить недоступность worker-а или coordinator-а с понятным retry/status для пользователя;
- `apps/shared/contracts` содержит типы и validators для нового `ClientRef`;
- документация и `.env.example` обновлены;
- `npm run typecheck` проходит.

## Быстрый шаблон реализации

1. Скопируйте структуру `apps/client/telegram` в `apps/client/<client-name>` или создайте файлы по минимальной структуре выше.
2. Замените platform слой на нужный SDK/API.
3. Добавьте `ClientType` и `ClientRef` в `apps/shared/contracts`.
4. Обновите validators и callback payload.
5. Реализуйте регистрацию, heartbeat и callback server.
6. Реализуйте upload в storage-node через `POST /storage/access`.
7. Реализуйте `POST /jobs`, обработку `202 queued`, polling assignment и прямой dispatch в worker.
8. Добавьте scripts, `.env.example`, README клиента и deploy package entry.
9. Запустите coordinator, storage-node, worker и новый клиент локально.
10. Проверьте happy path: пользовательский запрос -> storage upload -> assignment -> worker dispatch -> callback -> сообщение пользователю.
