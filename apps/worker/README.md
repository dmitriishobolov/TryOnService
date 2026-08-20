# Worker

Worker - сервис-исполнитель TryOnService. Он запускается на отдельном сервере, регистрируется в coordinator и выполняет тяжелую обработку клиентских данных через AI API.

Worker можно масштабировать горизонтально: поднимаем новый экземпляр, он сообщает coordinator о готовности, после чего coordinator может выдавать клиентам assignment на этот worker.

## Запуск

```bash
npm run dev:worker
```

По умолчанию worker пытается слушать порт `4001`. Если порт занят, worker выберет ближайший свободный порт, зарегистрирует его в coordinator и будет отправлять heartbeat каждые 5 секунд. Публичный адрес worker'а не нужно указывать напрямую: coordinator определяет IP по registration-запросу и собирает endpoint из `WORKER_PUBLIC_PROTOCOL` + IP + фактический worker port.

Если worker стоит за reverse proxy, NAT или доменом, где автоопределение не подходит, можно задать `WORKER_PUBLIC_URL` как ручной override.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/worker`.

## Подпапки

- [api](api/README.md) - связь worker'а с coordinator и локальный endpoint приема jobs от клиентов.
- [config](config/README.md) - настройки worker, AI API keys, лимиты и адрес coordinator.
- [models](models/README.md) - адаптеры к AI API и конкретным моделям.
- [runner](runner/README.md) - пайплайны обработки данных клиента.
- [utils](utils/README.md) - общие утилиты worker'а.

## Жизненный цикл

1. Worker стартует и загружает config.
2. Worker формирует `workerId`, `capacity` и список `capabilities`.
3. Worker регистрируется в coordinator через API и registration key.
4. Worker регулярно отправляет heartbeat.
5. Coordinator отправляет worker-у lightweight `POST /assignments` с `x-worker-service-key`, чтобы подготовить pending assignment под будущий client dispatch и передать callback token.
6. Client получает assignment от coordinator и отправляет heavy request на worker endpoint `POST /jobs` с `x-job-dispatch-token`.
7. Worker проверяет purpose/signature dispatch token, `workerId`, `jobId` и pending assignment, скачивает входные файлы по `StorageObjectRef`, запускает runner и вызывает нужные adapters из `models`.
8. Worker загружает generated files в object storage, отправляет progress/final status в coordinator по `x-worker-service-key` и клиентский результат напрямую в callback клиента с `x-client-callback-token`.

В текущем первом срезе runner использует mock model и возвращает текст `Ответ от сервера.`.

## Принципы

- Worker не должен быть источником правды по job state.
- Worker не должен отдавать клиентский результат через coordinator; callback клиента является основным каналом результата.
- Worker не должен хранить generated images как постоянное хранилище: после upload в object storage локальные временные файлы очищаются.
- Pending assignments должны учитываться в heartbeat load вместе с running jobs.
- Pending assignment должен отменяться через `POST /jobs/:jobId/cancel`, если coordinator сообщает, что клиент пропал или assignment истек.
- Временные файлы должны очищаться после обработки.
- Конкретные AI providers изолируются в `models`.
- Runner описывает бизнес-пайплайн, но не знает деталей HTTP API конкретного AI provider.
- Все входные и выходные данные сверяются с контрактами из `apps/shared`.
