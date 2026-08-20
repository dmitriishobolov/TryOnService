# Coordinator Storage

Coordinator storage слой создает object storage backend для файлов и изображений.

## Сейчас

- `STORAGE_DRIVER=local` - dev backend, файлы пишутся в `STORAGE_LOCAL_ROOT`.
- `STORAGE_PUBLIC_BASE_URL` - опциональная база URL, которая попадет в `StorageObjectRef.url`.

## Production направление

Для production нужен S3-compatible backend. Coordinator должен выдавать worker/client короткоживущие signed URLs или scoped credentials под конкретный job, а не раздавать master credentials.

Postgres хранит только metadata и object keys. Сами изображения лежат в object storage.
