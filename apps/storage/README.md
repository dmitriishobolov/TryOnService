# Object Storage Node

`apps/storage` - отдельный storage-сервис TryOnService. Он хранит изображения и файлы, сам регистрируется в coordinator и принимает прямой upload/download от clients и worker'ов.

Coordinator не проксирует файлы через себя: он только выбирает подходящий storage-node и выдает `StorageAccessAssignment` с `objectBaseUrl`, scoped `accessToken`, TTL и опциональным `keyPrefix`.

## Запуск

```bash
npm run dev:storage
```

По умолчанию storage-node слушает `http://localhost:4200`. Если порт занят, сервис выберет ближайший свободный порт и зарегистрирует в coordinator фактический endpoint.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/storage`.

## Подпапки

- [api](api/README.md) - HTTP API storage-node и client к coordinator для регистрации/heartbeat.
- [config](config/README.md) - настройки storage-node, ключи, лимиты и адрес coordinator.

## Жизненный цикл

1. Storage-node стартует, выбирает порт и backend `local` или `s3`.
2. Storage-node вызывает `POST /storage/register` coordinator-а с `x-storage-registration-key`.
3. Coordinator проверяет общий registration key, определяет публичный endpoint по IP registration-запроса + port или берет `STORAGE_PUBLIC_URL`.
4. Storage-node отправляет heartbeat каждые `STORAGE_HEARTBEAT_INTERVAL_MS`.
5. Client или worker запрашивает у coordinator `POST /storage/access`.
6. Client или worker вызывает storage-node напрямую:
   - `PUT /objects/<key>` для записи файла.
   - `GET /objects/<key>` для чтения файла.
7. Storage-node проверяет `x-storage-access-token`, scope, storageId, TTL, signing key version и keyPrefix.

## Правила

- Storage-node не знает Telegram, jobs workflow или AI API.
- Storage-node не принимает master credentials от clients/worker'ов.
- Доступ к объектам только по signed token purpose `storage-access`.
- Storage-node доверяет `keyPrefix` только из token coordinator-а; client/worker не могут расширить scope на стороне storage-node.
- `STORAGE_DRIVER=local` пишет файлы в `STORAGE_LOCAL_ROOT`.
- `STORAGE_DRIVER=s3` пишет файлы в S3-compatible backend напрямую из request stream.
- PUT/GET работают streaming-ом и не собирают объект целиком в память storage-node.
- `usedBytes` берется из metadata index (`STORAGE_METADATA_PATH` или файл рядом с storage root) и обновляется при PUT/DELETE без рекурсивного обхода папки.
- Upload response добавляет `storageId` в `StorageObjectRef`; client обязан передать этот ref в job payload без потери поля.
- Object keys должны быть scoped и предсказуемыми, например `clients/<clientId>/input/<requestId>/<file>` или `jobs/<jobId>/output/<file>`.
