# Client

`client` содержит клиентские интеграции TryOnService. Это каналы, через которые пользователи или внешние системы создают запросы на примерку и получают результат.

## Текущие направления

- [telegram](telegram/README.md) - Telegram bot/client с командой `/request`, callback server, автоматической регистрацией в coordinator и heartbeat.
- [NEW_CLIENT_GUIDE.md](NEW_CLIENT_GUIDE.md) - подробная универсальная инструкция по добавлению website, Discord и других будущих клиентов.

## Роль client слоя

Client слой должен:

- принимать пользовательский ввод;
- приводить его к контракту создания job;
- запрашивать у coordinator `POST /storage/access`, загружать входные файлы напрямую в storage-node и передавать coordinator только `StorageObjectRef`, когда сценарий работает с изображениями;
- регистрироваться в coordinator как service client, если интеграции нужен callback endpoint;
- запрашивать assignment в coordinator;
- отправлять `workerRequest` напрямую выбранному worker'у с dispatch token;
- принимать callback результата только если интеграция имеет callback endpoint и может проверить callback token;
- показывать пользователю статус и результат;
- не выполнять AI-обработку самостоятельно.

Для нескольких входных файлов client должен класть их в один storage-node и под общий object key prefix, например `clients/<clientId>/input/<requestId>/...`. Тогда coordinator сможет выдать worker'у read-only access только к этому `storageId` и prefix.

## Правила

- В client не должно быть секретов coordinator или AI provider'ов, кроме общего client key и callback signing key, которые нужны интеграции.
- Client не должен знать `WORKER_REGISTRATION_KEY`, `WORKER_SERVICE_KEY` или `WORKER_DISPATCH_SIGNING_KEY`; для прямой отправки job используется signed dispatch token из assignment.
- Callback service client должен знать `CLIENT_CALLBACK_SIGNING_KEY` и текущий `CLIENT_CALLBACK_SIGNING_KEY_VERSION`, чтобы проверить ответ worker'а.
- Client не должен хранить пользовательские фото как постоянное хранилище сервиса: после direct upload в storage-node локальные временные файлы можно очищать.
- Бизнес-логика пайплайна находится в worker runner.
- Форматы запросов берутся из `apps/shared/contracts`.

## Добавление новых клиентов

Для новой интеграции создавайте отдельную папку `apps/client/<client-name>` и начинайте с [инструкции по добавлению нового клиента](NEW_CLIENT_GUIDE.md). Сейчас публичные контракты реализуют только `telegram`, поэтому website, Discord или другой новый канал сначала требует расширения `ClientType`, `ClientRef` и runtime validators в `apps/shared/contracts`.
