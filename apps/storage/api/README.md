# Storage API

Папка содержит HTTP API storage-node и небольшой coordinator client для регистрации и heartbeat.

## Endpoints storage-node

- `GET /health` - health/status storage-node; требует `x-storage-service-key`.
- `PUT /objects/:key` - прямой upload объекта; требует `x-storage-access-token` со scope `write` или `read-write`.
- `GET /objects/:key` - прямое чтение объекта; требует `x-storage-access-token` со scope `read` или `read-write`.

`x-storage-access-token` подписывает coordinator через `STORAGE_ACCESS_SIGNING_KEY`. Storage-node проверяет подпись, `STORAGE_ACCESS_SIGNING_KEY_VERSION`, storageId, TTL, scope и keyPrefix локально, поэтому для чтения/записи файлов не нужен дополнительный roundtrip в coordinator.

PUT и GET работают потоково: storage-node не собирает объект целиком в память. После успешного PUT backend обновляет metadata index и `usedBytes` инкрементально.

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
- Ошибки возвращаются в общем формате `ApiErrorResponse`, кроме успешного `GET /objects/:key`, который отдает raw bytes.
