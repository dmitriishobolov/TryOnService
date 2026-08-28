# Coordinator API

Здесь находится HTTP API слой coordinator: routes, авторизация по service keys, runtime-валидация payload'ов и маппинг входящих HTTP-запросов в доменную логику.

## Клиентские endpoints

API для клиентов и интеграций должен отвечать за:

- создание job и выдачу assignment или queued-ответа на примерку;
- регистрацию service client при запуске;
- прием heartbeat от service client;
- выдачу storage-access для прямого upload/download в storage-node;
- lookup storage catalog по cacheKey товара/поиска без проксирования файлов;
- выдачу списка категорий и поиск `garment-item` для сценария `Идеальный образ`;
- получение статуса job;
- получение состояния обработки без обязательного хранения клиентского результата;
- отмену job, если сценарий это поддерживает.

`POST /jobs` принимает запросы только от зарегистрированных service clients: нужен `x-client-key`, обязательный `sourceClientId`, а callback URL берется из client registry. Клиентский `callbackUrl` из payload не используется как источник доверия. Если `payload.model.provider` указан, coordinator требует worker capability `try-on.<provider>`; если не указан, используется общий `try-on`. Если worker/storage capacity сейчас нет, endpoint возвращает `202` и `{ queued: true, job, retryAfterMs }`.

`GET /jobs/:jobId/assignment?sourceClientId=<clientId>` позволяет клиенту polling-ом дождаться assignment-а для своей queued job. Endpoint требует `x-client-key` и не выдает assignment для чужого `sourceClientId`.

`POST /jobs/:jobId/cancel` позволяет зарегистрированному client отменить только свою job в статусе `queued`. Клиент вызывает эту ручку, если перестал ждать assignment, чтобы старая queued job не осталась головой очереди и не блокировала следующие запросы.

`POST /storage/access` выдает клиенту или worker'у подходящий storage-node и scoped signed token. Если `storageId` не указан, coordinator выбирает свежий узел по минимальной доле `usedBytes/capacityBytes`, а при равной загрузке распределяет запросы между узлами. После этого файлы загружаются и читаются напрямую через storage-node, а coordinator получает только `StorageObjectRef` в payload/result.

`POST /storage/catalog/lookup` принимает `requesterId`, `requesterType`, `cacheKeys` и optional `kinds`. Endpoint требует `x-client-key` или `x-worker-service-key`, опрашивает все свежие storage-node через `STORAGE_SERVICE_KEY` и возвращает `locations`: storageId, baseUrl, найденный catalog entry, read-only `StorageAccessAssignment` и signed `objectUrl` на referenced object. Если разные storage-node хранят дополняющие entries по одному cacheKey, coordinator вернет все locations.

`POST /storage/catalog/garments/categories` принимает `requesterId` и `requesterType`, опрашивает все свежие storage-node и возвращает агрегированный список категорий `garment-item` с количеством записей.

`POST /storage/catalog/garments/search` принимает `categories`, `tags`, `text` и `limit`, опрашивает свежие storage-node, дедуплицирует одинаковые товары по `productUrl` или `storageId:cacheKey` и возвращает `GarmentCatalogItem[]` со signed `imageUrl` для прямого чтения изображения вещи.

Coordinator жестко нормализует и проверяет `keyPrefix`: client может получить доступ только к `clients/<clientId>` и вложенным ключам, worker - к `workers/<workerId>` или `jobs/...`. Запрос чужого prefix возвращает `403 storage_prefix_forbidden` и пишется в audit log.

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
- lookup cache entries через `POST /storage/catalog/lookup` для clients и worker'ов.
- garment catalog categories/search через `POST /storage/catalog/garments/categories` и `POST /storage/catalog/garments/search`.

Coordinator не принимает `dataBase64` и не отдает бинарные файлы. Его storage API - это control-plane: выбрать storage-node, проверить ключи, подписать token и сохранить registry state.

## Assignment flow

`POST /jobs` не отправляет heavy payload на worker. Coordinator создает queued job, затем пытается выбрать доступный worker, резервирует его capacity, переводит job в `assigned`, отправляет worker-у lightweight prepare-запрос и только после подтверждения возвращает клиенту:

- `job` - состояние job в coordinator.
- `worker` - endpoint выбранного worker'а и signed dispatch token.
- `workerRequest` - payload, который client отправляет в `POST /jobs` выбранного worker'а.
- `storage` - endpoint storage-node и storage-access token, если доступный storage-node найден.

Если в `payload.inputFiles` есть файлы, coordinator требует, чтобы все `StorageObjectRef` указывали на один `storageId`, а object keys лежали под общим prefix. Worker получает read-only token именно на этот storage-node и prefix. Для записи generated files worker может запросить отдельный write/read-write token через `POST /storage/access`.

Dispatch token подписан `WORKER_DISPATCH_SIGNING_KEY`, но сам секрет клиенту не передается. Worker проверяет token локально и принимает только job, где token имеет purpose `worker-dispatch`, привязан к его `workerId` и `jobId`, содержит текущий `keyVersion` и еще не использованный `tokenId`.

Для результата worker -> client coordinator создает отдельный callback token с purpose `client-callback`, подписанный `CLIENT_CALLBACK_SIGNING_KEY`. Token передается worker-у только в prepare-запросе и затем идет в `x-client-callback-token` на callback endpoint клиента. Telegram client проверяет `keyVersion` и защищается от повторного использования `tokenId`.

Если prepare на worker-е не прошел, coordinator освобождает worker slot, возвращает job в очередь и не отдает этот worker клиенту.

## Failure handling

- Stale worker heartbeat: worker помечается offline, активные jobs этого worker'а переводятся в `failed`.
- Stale client heartbeat: client помечается offline, coordinator пытается отменить pending/running job на worker-е; при подтвержденной отмене job становится `cancelled`, иначе capacity не освобождается до финального отчета worker-а.
- Expired assignment: coordinator отправляет worker-у cancel; если cancel подтвержден, job возвращается в `queued`, worker slot освобождается.
- Client queue timeout: client вызывает `POST /jobs/:jobId/cancel` для своей queued job; coordinator переводит ее в `cancelled`, и следующий queued job может стать новой головой очереди.

## Registration Security

`POST /workers/register` проверяет общий `x-worker-registration-key`. Если registration key неверный, coordinator считает ошибку по прямому remote IP. После превышения `WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS` IP получает `403 worker_registration_ip_banned`. В memory backend ban живет до restart, в Postgres backend хранится в `tryon_registration_bans`.

`POST /storage/register` использует такую же схему с общим `x-storage-registration-key` и лимитом `STORAGE_REGISTRATION_MAX_INVALID_ATTEMPTS`. Заблокированный IP получает `403 storage_registration_ip_banned`.

`POST /clients/register` также считает неверные `x-client-key` по direct remote IP. После `CLIENT_REGISTRATION_MAX_INVALID_ATTEMPTS` неверных попыток IP получает `403 client_registration_ip_banned`.

При `REQUIRE_HTTPS_ENDPOINTS=true` registration отклоняет public endpoints без `https`. mTLS реализуется на reverse proxy/private network уровне перед Node.js процессами.

Для бана используется socket remote address, а не `x-forwarded-for`. Заголовки `x-forwarded-for` и `x-real-ip` используются отдельно, только когда coordinator собирает публичный endpoint зарегистрированного worker/client.

Security events пишутся в audit store; в Postgres это `tryon_security_events`.

## Ключи и лимиты

- `x-client-key` - регистрация/heartbeat service clients и создание jobs по общему `CLIENT_REGISTRATION_KEY`.
- `x-worker-registration-key` - registration gate worker'а.
- `x-worker-service-key` - heartbeat worker'а, prepare assignment, progress/result и cancel после регистрации.
- `x-storage-registration-key` - registration gate storage-node.
- `x-storage-service-key` - heartbeat/health storage-node после регистрации.
- `POST /storage/catalog/lookup` - lookup cached product/search locations; требует client или worker service key и не проксирует объект.
- `POST /storage/catalog/garments/categories`, `POST /storage/catalog/garments/search` - чтение каталога вещей для clients/worker'ов через coordinator без проксирования файлов.
- `POST /jobs/:jobId/cancel` - отмена собственной queued job клиентом; требует `x-client-key`.
- `x-storage-access-token` - не используется coordinator-ом; с ним client/worker ходят напрямую в storage-node.
- `x-admin-key` - debug/admin ручки `GET /health`, `GET /jobs`, `GET /jobs/:id`.
- `GET /security/events?limit=100` - admin endpoint для просмотра audit events; требует `x-admin-key`.
- `API_RATE_LIMIT_WINDOW_MS` и `API_RATE_LIMIT_MAX_REQUESTS` задают простой fixed-window rate limit по direct remote IP.
- `MAX_JSON_BODY_BYTES` ограничивает размер входящих JSON body.

## Правила

- В API не должно быть тяжелой бизнес-логики обработки изображений.
- Coordinator API не должен становиться file data-plane; direct upload/download идет через storage-node.
- API coordinator не должен проксировать клиентский результат.
- Все входящие payloads валидируются через контракты из `apps/shared/contracts`.
- Ошибки должны возвращаться в едином формате, чтобы client и worker могли одинаково их обрабатывать.
- API keys и signing secrets не должны логироваться.
