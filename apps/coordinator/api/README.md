# Coordinator API

Здесь находится HTTP API слой coordinator: routes, авторизация по service keys, runtime-валидация payload'ов и маппинг входящих HTTP-запросов в доменную логику.

## Клиентские endpoints

API для клиентов и интеграций должен отвечать за:

- создание job assignment на примерку;
- регистрацию service client при запуске;
- прием heartbeat от service client;
- выдачу storage-access для прямого upload/download в storage-node;
- получение статуса job;
- получение состояния обработки без обязательного хранения клиентского результата;
- отмену job, если сценарий это поддерживает.

`POST /jobs` принимает запросы только от зарегистрированных service clients: нужен `x-client-key`, обязательный `sourceClientId`, а callback URL берется из client registry. Клиентский `callbackUrl` из payload не используется как источник доверия.

`POST /storage/access` выдает клиенту или worker'у подходящий storage-node и scoped signed token. После этого файлы загружаются и читаются напрямую через storage-node, а coordinator получает только `StorageObjectRef` в payload/result.

## Worker endpoints

API для worker'ов должен отвечать за:

- регистрацию worker'а при запуске;
- прием heartbeat;
- прием progress/result status по job, которую client отправил worker'у напрямую;
- обновление прогресса и финального статуса;
- сообщение об ошибках выполнения;
- отмену pending assignment через worker `POST /jobs/:jobId/cancel`, когда клиент пропал или assignment истек.

## Storage endpoints

Storage-node API на стороне coordinator отвечает за:

- регистрацию storage-node через `POST /storage/register` и `x-storage-registration-key`;
- heartbeat через `POST /storage/:storageId/heartbeat` и `x-storage-service-key`;
- выдачу storage-access через `POST /storage/access` для clients и worker'ов.

Coordinator не принимает `dataBase64` и не отдает бинарные файлы. Его storage API - это control-plane: выбрать storage-node, проверить ключи, подписать token и сохранить registry state.

## Assignment flow

`POST /jobs` не отправляет heavy payload на worker. Coordinator выбирает доступный worker, резервирует его capacity, создает `assigned` job, отправляет worker-у lightweight prepare-запрос и только после подтверждения возвращает клиенту:

- `job` - состояние job в coordinator.
- `worker` - endpoint выбранного worker'а и signed dispatch token.
- `workerRequest` - payload, который client отправляет в `POST /jobs` выбранного worker'а.
- `storage` - endpoint storage-node и storage-access token, если доступный storage-node найден.

Если в `payload.inputFiles` есть файлы, coordinator требует, чтобы все `StorageObjectRef` указывали на один `storageId`, а object keys лежали под общим prefix. Worker получает read-only token именно на этот storage-node и prefix. Для записи generated files worker может запросить отдельный write/read-write token через `POST /storage/access`.

Dispatch token подписан `WORKER_DISPATCH_SIGNING_KEY`, но сам секрет клиенту не передается. Worker проверяет token локально и принимает только job, где token имеет purpose `worker-dispatch` и привязан к его `workerId` и `jobId`.

Для результата worker -> client coordinator создает отдельный callback token с purpose `client-callback`, подписанный `CLIENT_CALLBACK_SIGNING_KEY`. Token передается worker-у только в prepare-запросе и затем идет в `x-client-callback-token` на callback endpoint клиента.

Если prepare на worker-е не прошел, coordinator освобождает worker slot, помечает job как `failed` с `worker_prepare_failed` и не отдает этот worker клиенту.

## Failure handling

- Stale worker heartbeat: worker помечается offline, активные jobs этого worker'а переводятся в `failed`.
- Stale client heartbeat: client помечается offline, активные jobs этого client переводятся в `failed`, зарезервированные worker slots освобождаются.
- Expired assignment: job переводится в `failed`, worker slot освобождается.

## Защита worker registration

`POST /workers/register` проверяет `x-worker-registration-key`. Если ключ неверный, coordinator считает ошибку по прямому remote IP. После превышения `WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS` IP получает `403 worker_registration_ip_banned` и остается заблокированным до перезапуска coordinator.

`POST /storage/register` использует такую же схему с `x-storage-registration-key` и лимитом `STORAGE_REGISTRATION_MAX_INVALID_ATTEMPTS`. Заблокированный IP получает `403 storage_registration_ip_banned` до перезапуска coordinator.

`POST /clients/register` также считает неверные `x-client-key` по direct remote IP. После `CLIENT_REGISTRATION_MAX_INVALID_ATTEMPTS` неверных попыток IP получает `403 client_registration_ip_banned` до перезапуска coordinator.

Для бана используется socket remote address, а не `x-forwarded-for`. Заголовки `x-forwarded-for` и `x-real-ip` используются отдельно, только когда coordinator собирает публичный endpoint зарегистрированного worker/client.

## Ключи и лимиты

- `x-client-key` - регистрация/heartbeat service clients и создание jobs.
- `x-worker-registration-key` - только регистрация worker'а.
- `x-worker-service-key` - heartbeat worker'а, prepare assignment, progress/result и cancel.
- `x-storage-registration-key` - только регистрация storage-node.
- `x-storage-service-key` - heartbeat/health storage-node.
- `x-storage-access-token` - не используется coordinator-ом; с ним client/worker ходят напрямую в storage-node.
- `x-admin-key` - debug/admin ручки `GET /health`, `GET /jobs`, `GET /jobs/:id`.
- `API_RATE_LIMIT_WINDOW_MS` и `API_RATE_LIMIT_MAX_REQUESTS` задают простой fixed-window rate limit по direct remote IP.
- `MAX_JSON_BODY_BYTES` ограничивает размер входящих JSON body.

## Правила

- В API не должно быть тяжелой бизнес-логики обработки изображений.
- Coordinator API не должен становиться file data-plane; direct upload/download идет через storage-node.
- API coordinator не должен проксировать клиентский результат.
- Все входящие payloads валидируются через контракты из `apps/shared/contracts`.
- Ошибки должны возвращаться в едином формате, чтобы client и worker могли одинаково их обрабатывать.
- API keys и signing secrets не должны логироваться.
