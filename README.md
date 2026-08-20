# TryOnService

TryOnService - сервис примерки на базе AI API. Проект проектируется как расширяемая Node.js + TypeScript система, где coordinator подбирает подходящий worker для клиента, а тяжелую обработку выполняют независимые worker-серверы.

Главная идея архитектуры: coordinator не должен становиться узким местом для клиентских результатов. Он ведет registry worker'ов и service clients, выбирает подходящий worker, заранее сообщает worker-у о будущем client connection для конкретной job, затем возвращает клиенту endpoint worker'а с подписанным dispatch token. После этого клиент отправляет heavy request worker'у напрямую, а worker отправляет результат напрямую в callback клиента.

## Статус проекта

Сейчас реализован первый вертикальный срез на Node.js/TypeScript:

- coordinator регистрирует worker'ы и service clients, получает heartbeat, выбирает worker по capacity/capabilities, готовит assignment на worker-е и возвращает клиенту выбранный worker;
- worker при запуске подбирает свободный порт, регистрируется в coordinator, каждые 5 секунд отправляет heartbeat с учетом running jobs и pending assignments, принимает jobs напрямую от клиентов только после prepare от coordinator;
- Telegram client подбирает свободный callback-порт, регистрируется в coordinator, показывает команду `/request`, кнопку `Request`, получает assignment, отправляет job worker'у напрямую и выводит пользователю ответ worker'а.
- coordinator защищает регистрацию worker'ов от перебора ключа: после превышения лимита неверных попыток IP блокируется до перезапуска coordinator.

## Как устроен сервис

```mermaid
flowchart LR
    Client["Client integrations"] -->|"request assignment"| CoordinatorAPI["Coordinator API"]
    CoordinatorAPI --> Jobs["Jobs"]
    CoordinatorAPI --> Registry["Worker/client registry"]
    CoordinatorAPI --> Security["Registration guard"]
    CoordinatorAPI -->|"prepare assignment"| WorkerAPI
    CoordinatorAPI -->|"worker endpoint + dispatch token"| Client
    Client -->|"direct job dispatch"| WorkerAPI["Worker API"]
    WorkerAPI --> Runner["Runner"]
    Runner --> Models["AI API models"]
    Models --> AI["External AI APIs"]
    Runner -->|"status only"| CoordinatorAPI
    Runner -->|"result callback"| Client
```

1. Client и worker при запуске регистрируются в coordinator и регулярно подтверждают доступность.
2. Клиент отправляет запрос на assignment в coordinator.
3. Coordinator валидирует запрос, находит callback URL клиента, выбирает доступный worker, резервирует capacity и создает job.
4. Coordinator отправляет worker-у lightweight prepare-запрос: `jobId`, client/callback metadata, required capabilities и срок жизни token.
5. Если worker подтвердил prepare, coordinator возвращает клиенту assignment с worker endpoint, `workerRequest` и signed dispatch token.
6. Клиент отправляет heavy request напрямую на worker endpoint с `x-job-dispatch-token`.
7. Worker принимает job только если token валиден и assignment заранее подготовлен coordinator-ом, затем запускает runner.
8. Worker отправляет status-only update в coordinator и результат на callback клиента.

## Структура репозитория

- [apps](apps/README.md) - все приложения и общие пакеты монорепозитория.
- [apps/coordinator](apps/coordinator/README.md) - сервис-координатор: API assignment, jobs state, registry worker'ов/service clients, assignment cleanup и coordinator utilities.
- [apps/worker](apps/worker/README.md) - исполняющий сервис: регистрация в coordinator, запуск пайплайнов, вызовы AI API.
- [apps/shared](apps/shared/README.md) - общие контракты, DTO, типы и схемы валидации.
- [apps/client](apps/client/README.md) - клиентские интеграции, через которые пользователи создают задачи.
- `DemoPhotos/` - локальная игнорируемая папка для демонстрационных фотографий, не хранится в git.

## Основные зоны ответственности

Coordinator:

- принимает внешние запросы от клиентов и внутренних сервисов;
- хранит состояние jobs и историю переходов;
- ведет реестр worker'ов и service clients, их heartbeat, capacity и capabilities;
- подбирает worker, готовит pending assignment на worker-е и выдает клиенту signed assignment для прямой отправки job;
- чистит просроченные assignments и освобождает capacity worker'а;
- блокирует IP, которые пытаются подобрать `WORKER_REGISTRATION_KEY` через регистрацию worker'а.

Worker:

- при старте читает конфиг и регистрируется в coordinator по API key;
- сообщает о готовности, capacity и поддерживаемых моделях/пайплайнах;
- держит pending assignments, принимает jobs от клиентов по signed dispatch token, запускает runner и обновляет статус выполнения;
- отправляет клиентский результат напрямую в callback URL из assignment;
- изолирует конкретные AI API в `apps/worker/models`.

Shared:

- хранит типы запросов, ответов, статусов jobs и worker'ов;
- задает единый контракт между coordinator, worker и клиентами;
- должен изменяться первым, если меняется публичный формат данных.

## Локальный запуск

Установите зависимости:

```bash
npm install
```

Создайте локальный `.env` из примера и заполните токен Telegram-бота:

```powershell
Copy-Item .env.example .env
```

Запустите coordinator:

```bash
npm run dev:coordinator
```

В отдельном терминале запустите worker:

```bash
npm run dev:worker
```

В отдельном терминале запустите Telegram client:

```bash
npm run dev:telegram
```

По умолчанию используются адреса:

- coordinator: `http://localhost:3000`
- worker: `http://localhost:4001`
- telegram callback server: `http://localhost:4100`

Если основной порт worker или Telegram client занят, сервис автоматически выберет ближайший свободный порт и зарегистрирует в coordinator фактический порт.

Если worker, coordinator и Telegram client запускаются не на одной машине, задайте публичные URL через `COORDINATOR_PUBLIC_URL` и `COORDINATOR_URL`. Адреса worker'а и Telegram client callback server coordinator определяет сам по IP registration-запроса и выбранному порту.

Если автоопределение публичного endpoint не подходит из-за NAT, reverse proxy или домена, задайте override через `WORKER_PUBLIC_URL` или `TELEGRAM_CLIENT_PUBLIC_URL`.

## Безопасность регистрации

Worker и service client регистрируются в coordinator по разным ключам:

- `WORKER_REGISTRATION_KEY` - ключ worker'ов.
- `CLIENT_REGISTRATION_KEY` - ключ клиентов-интеграций.

Для worker registration есть in-memory защита от перебора: если один direct remote IP отправит больше `WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS` неверных ключей в `POST /workers/register`, coordinator вернет `403 worker_registration_ip_banned` и будет держать этот IP в бане до перезапуска процесса.

Адрес для бана берется из прямого socket remote address, а не из `x-forwarded-for`, чтобы атакующий не мог легко менять IP заголовком. `x-forwarded-for` и `x-real-ip` используются только для автоопределения публичного endpoint worker/client при регистрации.

## Проверка без Telegram

Можно проверить matchmaking coordinator + прямую отправку job worker'у через PowerShell:

```powershell
$assignment = curl.exe -s -X POST http://localhost:3000/jobs `
  -H "Content-Type: application/json" `
  --data '{"client":{"type":"telegram","chatId":"local-dev"},"payload":{"command":"request"}}' | ConvertFrom-Json

curl.exe -s -X POST $assignment.worker.jobUrl `
  -H "Content-Type: application/json" `
  -H "x-job-dispatch-token: $($assignment.worker.dispatchToken)" `
  --data ($assignment.workerRequest | ConvertTo-Json -Depth 10 -Compress)
```

После обработки job в `GET http://localhost:3000/jobs` статус станет `succeeded`. Сам клиентский ответ не проходит через coordinator: worker отправляет его только в callback URL клиента, если он был указан в assignment.

Если worker перестал отправлять heartbeat во время обработки, coordinator помечает его offline и переводит активные jobs этого worker'а в `failed`. Если service client перестал отправлять heartbeat, coordinator помечает client offline, освобождает зарезервированные worker slots и переводит активные jobs этого client в `failed`.

## Сборка deploy-пакетов

Чтобы получить готовые папки для переноса на серверы, заполните локальный `.env` нужными адресами и выполните:

```bash
npm run build:dist
```

Результат появится в `dist/packages`:

- `dist/packages/coordinator` - готовый coordinator.
- `dist/packages/worker` - готовый worker.
- `dist/packages/telegram-client` - готовый Telegram client.

Каждый пакет содержит:

- `app/` - скомпилированный JavaScript;
- `.env` - настройки, сгенерированные из локального `.env`;
- `start.cmd` - запуск на Windows;
- `start.sh` - запуск на Linux/macOS;
- `package.json` - минимальный package-файл с `npm start`;
- `BUILD_INFO.txt` - commit и время сборки.

Для запуска deploy-пакета на сервере нужен Node.js `>=18`; выполнять `npm install` внутри пакета не нужно, потому что runtime-зависимости сейчас не используются.

`dist/packages/*/.env` содержит значения из локального `.env`, включая токены, поэтому `dist/` не хранится в git и должен передаваться только в нужное окружение.

Для production-сборки с отдельным набором адресов можно использовать другой env-файл:

```powershell
$env:BUILD_ENV_FILE=".env.production"
npm run build:dist
```

По умолчанию `BUILD_ENV_FILE=.env` указан в `.env.example`, поэтому обычная сборка берет настройки из локального `.env`.

Минимально важные адреса:

- `COORDINATOR_PUBLIC_URL` - публичный URL coordinator для status callbacks от worker'ов.
- `COORDINATOR_URL` - адрес coordinator для worker и Telegram client.
- `WORKER_REGISTRATION_KEY` - ключ регистрации worker'ов в coordinator.
- `WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS` - сколько неверных registration-ключей с одного IP допускается до бана; по умолчанию `5`.
- `WORKER_PORT` - порт worker; coordinator использует его вместе с IP registration-запроса, чтобы отправлять jobs на worker.
- `WORKER_PUBLIC_PROTOCOL` - протокол публичного worker endpoint, обычно `http` или `https`.
- `WORKER_PUBLIC_URL` - опциональный ручной override для worker endpoint, если автоопределение по IP/port не подходит.
- `WORKER_DISPATCH_TOKEN_TTL_MS` - срок жизни signed token, по которому клиент может отправить конкретную job конкретному worker'у.
- `JOB_ASSIGNMENT_TIMEOUT_MS` - сколько coordinator держит assignment в статусе `assigned`, если клиент не успел отправить job worker'у.
- `TELEGRAM_CLIENT_PUBLIC_PROTOCOL` - протокол публичного Telegram callback endpoint.
- `TELEGRAM_CLIENT_PUBLIC_URL` - опциональный ручной override для Telegram callback endpoint, если автоопределение по IP/port не подходит.
- `CLIENT_REGISTRATION_KEY` - ключ регистрации service clients в coordinator.

## Расширение системы

- Новый AI provider добавляйте в [apps/worker/models](apps/worker/models/README.md).
- Новый сценарий обработки данных клиента добавляйте в [apps/worker/runner](apps/worker/runner/README.md).
- Новый endpoint coordinator добавляйте в [apps/coordinator/api](apps/coordinator/api/README.md).
- Новое состояние job или worker сначала описывайте в [apps/shared/contracts](apps/shared/contracts/README.md).
- Новую клиентскую интеграцию добавляйте в [apps/client](apps/client/README.md).

## Принципы разработки

- Contracts first: общие DTO и статусы должны жить в `apps/shared`.
- Worker'ы должны быть максимально stateless: локально допустимы только временные файлы обработки.
- Все внешние AI API должны быть закрыты адаптерами в `models`, чтобы runner не зависел от конкретного провайдера.
- Jobs должны быть идемпотентными там, где это возможно: повторная обработка не должна ломать состояние клиента.
- Секреты, API keys и токены не хранятся в git. Используйте `.env` или секрет-хранилище окружения.
