# Client

`client` содержит клиентские интеграции TryOnService. Это каналы, через которые пользователи или внешние системы создают запросы на примерку и получают результат.

## Текущие направления

- [telegram](telegram/README.md) - Telegram bot/client с командой `/request`, callback server, автоматической регистрацией в coordinator и heartbeat.

## Роль client слоя

Client слой должен:

- принимать пользовательский ввод;
- приводить его к контракту создания job;
- загружать входные файлы в object storage и передавать coordinator `StorageObjectRef`, когда сценарий работает с изображениями;
- регистрироваться в coordinator как service client, если интеграции нужен callback endpoint;
- запрашивать assignment в coordinator;
- отправлять `workerRequest` напрямую выбранному worker'у с dispatch token;
- принимать callback результата только если интеграция имеет callback endpoint и может проверить callback token;
- показывать пользователю статус и результат;
- не выполнять AI-обработку самостоятельно.

## Правила

- В client не должно быть секретов coordinator или AI provider'ов, кроме тех, которые нужны самой интеграции.
- Client не должен знать `WORKER_REGISTRATION_KEY`, `WORKER_SERVICE_KEY` или `WORKER_DISPATCH_SIGNING_KEY`; для прямой отправки job используется signed dispatch token из assignment.
- Callback service client должен знать `CLIENT_CALLBACK_SIGNING_KEY`, чтобы проверить ответ worker'а.
- Client не должен хранить пользовательские фото как постоянное хранилище сервиса: после upload в object storage локальные временные файлы можно очищать.
- Бизнес-логика пайплайна находится в worker runner.
- Форматы запросов берутся из `apps/shared/contracts`.
