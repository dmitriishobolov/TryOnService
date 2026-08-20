# Shared Storage

Storage слой описывает работу с файлами и изображениями через object keys. Сервисы не должны пересылать большие бинарные данные через coordinator или хранить их в Postgres.

## Текущая реализация

- `ObjectStorage` - общий интерфейс для записи, чтения, stream-read и удаления объекта.
- `LocalObjectStorage` - dev backend, который пишет файлы в локальную папку и возвращает `StorageObjectRef`.

`StorageObjectRef` живет в `apps/shared/contracts`: его можно передавать в `CreateTryOnJobRequest.payload.inputFiles` и `TryOnJobResult.files`. Реальный HTTP upload/download выполняет `apps/storage`: coordinator только выдает storage endpoint и signed access token. Для объектов, загруженных через storage-node, ref должен содержать `storageId`, чтобы worker получил доступ к правильному узлу.

## Production направление

Для production нужен S3-compatible backend внутри storage-node или выделенный storage provider: AWS S3, Cloudflare R2, MinIO, Yandex Object Storage. Воркерам и клиентам не нужно знать master credentials storage. Coordinator выдает короткоживущий scoped token, а storage-node проверяет его локально.

## Правила

- В Postgres храним metadata и object keys, не сами изображения.
- Локальные временные файлы worker/client очищаются после обработки.
- Object keys должны быть job-scoped, например `jobs/<jobId>/input/person.jpg`.
- Ссылки на скачивание должны иметь TTL, если они публичные или presigned.
