# Object Storage Node

`apps/storage` - отдельный storage-сервис TryOnService. Он хранит изображения, файлы и локальный catalog index cache-объектов, сам регистрируется в coordinator и принимает прямой upload/download от clients и worker'ов.

Coordinator не проксирует файлы через себя: он выбирает подходящий storage-node по heartbeat, свободному месту и текущей загрузке, выдает `StorageAccessAssignment` с `objectBaseUrl`, scoped `accessToken`, TTL и опциональным `keyPrefix`, а для cache lookup опрашивает зарегистрированные storage-node и возвращает locations найденных объектов.

## Запуск

```bash
npm run dev:storage
```

По умолчанию storage-node слушает `http://localhost:4200`. Если порт занят, сервис выберет ближайший свободный порт и зарегистрирует в coordinator фактический endpoint.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/storage`.

## Подпапки

- [api](api/README.md) - HTTP API storage-node и client к coordinator для регистрации/heartbeat.
- [config](config/README.md) - настройки storage-node, ключи, лимиты и адрес coordinator.

## Garment Catalog

Для сценария `Идеальный образ` storage-node хранит catalog entries с `kind=garment-item`. Такая запись указывает на уже загруженное изображение вещи и содержит metadata:

- `category` - роль вещи в образе, например `рубашка`, `брюки`, `куртка`.
- `title` и `description` - короткое название и описание товара.
- `tags`, `colorTags`, `styleTags`, `materialTags` - признаки, по которым OpenAI выбирает вещи под пользователя.
- `price`, `currency`, `store`, `productUrl` - данные для карточки товара в клиенте.

Изображение должно быть чистым front-view на белом или контрастном фоне, без человека, лишней одежды и сильной обрезки. Worker получает категории через coordinator, ищет до 5 кандидатов на выбранную категорию и использует `imageUrl` этих записей для выбора и TryOn.

## Жизненный цикл

1. Storage-node стартует, выбирает порт и backend `local` или `s3`.
2. Если `STORAGE_ID` пустой, storage-node читает auto-id из `STORAGE_ID_PATH` или `STORAGE_LOCAL_ROOT/.tryon-storage-id`; если файла нет, генерирует новый id и сохраняет его.
3. Storage-node вызывает `POST /storage/register` coordinator-а с `x-storage-registration-key`.
4. Coordinator проверяет общий registration key, определяет публичный endpoint по IP registration-запроса + port или берет `STORAGE_PUBLIC_URL`.
5. Storage-node отправляет heartbeat каждые `STORAGE_HEARTBEAT_INTERVAL_MS`.
6. Client или worker запрашивает у coordinator `POST /storage/access`.
7. Client или worker вызывает storage-node напрямую:
   - `PUT /objects/<key>` для записи файла.
   - `GET /objects/<key>` для чтения файла.
   - `POST /catalog/entries` для регистрации связи `cacheKey -> objectKey`.
8. Storage-node проверяет `x-storage-access-token`, scope, storageId, TTL, signing key version и keyPrefix.
9. Для cache lookup client/worker вызывает coordinator `POST /storage/catalog/lookup`, coordinator опрашивает все свежие storage-node через `POST /catalog/lookup` и возвращает один или несколько найденных locations с read-token на конкретный prefix.

## Правила

- Storage-node не знает Telegram, jobs workflow или AI API.
- Storage-node не принимает master credentials от clients/worker'ов.
- Доступ к объектам только по signed token purpose `storage-access`.
- Для `GET /objects/<key>` token можно передать header-ом `x-storage-access-token` или query-параметром `accessToken`. Query-вариант нужен для внешних клиентов вроде Telegram `sendPhoto`, которым проще отдать готовый URL.
- Если объект не найден, storage-node возвращает `404 object_not_found`.
- Storage-node доверяет `keyPrefix` только из token coordinator-а; client/worker не могут расширить scope на стороне storage-node.
- `STORAGE_DRIVER=local` пишет файлы в `STORAGE_LOCAL_ROOT`.
- `STORAGE_DRIVER=s3` пишет файлы в S3-compatible backend напрямую из request stream.
- Один и тот же deploy-пакет storage можно закинуть на новую машину и запустить без ручного `STORAGE_ID`: узел сам создаст стабильную identity в runtime-файле и зарегистрируется в coordinator.
- PUT/GET работают streaming-ом и не собирают объект целиком в память storage-node.
- `usedBytes` берется из metadata index (`STORAGE_METADATA_PATH` или файл рядом с storage root) и обновляется при PUT/DELETE без рекурсивного обхода папки.
- Catalog index хранится отдельно (`STORAGE_CATALOG_PATH` или файл рядом с storage root), переживает restart storage-node и при lookup проверяет, что referenced object ещё существует.
- Upload response добавляет `storageId` в `StorageObjectRef`; client обязан передать этот ref в job payload без потери поля.
- Object keys должны быть scoped и предсказуемыми, например `clients/<clientId>/input/<requestId>/<file>` или `jobs/<jobId>/output/<file>`.
