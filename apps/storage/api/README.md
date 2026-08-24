# Storage API

Папка содержит HTTP API storage-node и небольшой coordinator client для регистрации и heartbeat.

## Endpoints storage-node

- `GET /health` - health/status storage-node; требует `x-storage-service-key`.
- `PUT /objects/:key` - прямой upload объекта; требует `x-storage-access-token` со scope `write` или `read-write`.
- `GET /objects/:key` - прямое чтение объекта; требует `x-storage-access-token` со scope `read` или `read-write`. Для пользовательских preview/download URL можно передать тот же token как query-параметр `accessToken`.
- `POST /catalog/lookup` - internal lookup catalog entries по `cacheKeys`/`kinds`; требует `x-storage-service-key` и вызывается coordinator-ом.
- `POST /catalog/entries` - upsert catalog entry `cacheKey -> objectKey`; требует `x-storage-access-token` со scope `write`/`read-write`, причем token должен разрешать referenced `objectKey`.

`x-storage-access-token` или query `accessToken` подписывает coordinator через `STORAGE_ACCESS_SIGNING_KEY`. Storage-node проверяет подпись, `STORAGE_ACCESS_SIGNING_KEY_VERSION`, storageId, TTL, scope и keyPrefix локально, поэтому для чтения/записи файлов не нужен дополнительный roundtrip в coordinator.

PUT и GET работают потоково: storage-node не собирает объект целиком в память. После успешного PUT backend обновляет metadata index и `usedBytes` инкрементально.

Catalog entry не содержит бинарных данных. Он связывает cache key с уже загруженным объектом и optional metadata. Сейчас контракт оставляет cache kinds `product-card-image` и `product-card-metadata` для будущих сценариев повторного использования generated assets. При lookup storage-node проверяет, что objectKey ещё существует, и удаляет устаревшие/битые записи из catalog index.

## Coordinator client

`coordinatorClient.ts` делает:

- `POST /storage/register` с `x-storage-registration-key`;
- `POST /storage/:storageId/heartbeat` с `x-storage-service-key`.

## Правила

- Storage API не должен принимать JSON/base64 для файлов; upload идет raw body.
- Rate limit применяется по direct remote IP.
- Размер одного объекта ограничивается `STORAGE_MAX_OBJECT_BYTES`.
- Object key нормализуется как POSIX path и не может содержать выход через `..`.
- Если token содержит `keyPrefix`, upload/download разрешен только внутри этого prefix.
- Query `accessToken` поддерживается только для `GET /objects/:key`; upload всегда использует header `x-storage-access-token`.
- Catalog lookup между coordinator и storage-node идет только по `STORAGE_SERVICE_KEY`; clients/worker'ы не ходят по всем storage-node напрямую.
- Ошибки возвращаются в общем формате `ApiErrorResponse`, кроме успешного `GET /objects/:key`, который отдает raw bytes.
