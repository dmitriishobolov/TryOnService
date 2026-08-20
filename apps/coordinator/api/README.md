# Coordinator API

Здесь находится HTTP API слой coordinator: routes, авторизация по service keys, runtime-валидация payload'ов и маппинг входящих HTTP-запросов в доменную логику.

## Клиентские endpoints

API для клиентов и интеграций должен отвечать за:

- создание job assignment на примерку;
- регистрацию service client при запуске;
- прием heartbeat от service client;
- получение статуса job;
- получение состояния обработки без обязательного хранения клиентского результата;
- отмену job, если сценарий это поддерживает.

## Worker endpoints

API для worker'ов должен отвечать за:

- регистрацию worker'а при запуске;
- прием heartbeat;
- прием progress/result status по job, которую client отправил worker'у напрямую;
- обновление прогресса и финального статуса;
- сообщение об ошибках выполнения.

## Assignment flow

`POST /jobs` не отправляет heavy payload на worker. Coordinator выбирает доступный worker, резервирует его capacity, создает `assigned` job, отправляет worker-у lightweight prepare-запрос и только после подтверждения возвращает клиенту:

- `job` - состояние job в coordinator.
- `worker` - endpoint выбранного worker'а и signed dispatch token.
- `workerRequest` - payload, который client отправляет в `POST /jobs` выбранного worker'а.

Dispatch token подписан `WORKER_REGISTRATION_KEY`, но сам ключ клиенту не передается. Worker проверяет token локально и принимает только job, где token привязан к его `workerId` и `jobId`.

Если prepare на worker-е не прошел, coordinator освобождает worker slot, помечает job как `failed` с `worker_prepare_failed` и не отдает этот worker клиенту.

## Failure handling

- Stale worker heartbeat: worker помечается offline, активные jobs этого worker'а переводятся в `failed`.
- Stale client heartbeat: client помечается offline, активные jobs этого client переводятся в `failed`, зарезервированные worker slots освобождаются.
- Expired assignment: job переводится в `failed`, worker slot освобождается.

## Защита worker registration

`POST /workers/register` проверяет `x-worker-key`. Если ключ неверный, coordinator считает ошибку по прямому remote IP. После превышения `WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS` IP получает `403 worker_registration_ip_banned` и остается заблокированным до перезапуска coordinator.

Для бана используется socket remote address, а не `x-forwarded-for`. Заголовки `x-forwarded-for` и `x-real-ip` используются отдельно, только когда coordinator собирает публичный endpoint зарегистрированного worker/client.

## Правила

- В API не должно быть тяжелой бизнес-логики обработки изображений.
- API coordinator не должен проксировать клиентский результат.
- Все входящие payloads валидируются через контракты из `apps/shared/contracts`.
- Ошибки должны возвращаться в едином формате, чтобы client и worker могли одинаково их обрабатывать.
- API key для worker registration и service-to-service операций не должен логироваться.
