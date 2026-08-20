# Coordinator API

Здесь находится HTTP API слой coordinator: routes, авторизация по service keys, runtime-валидация payload'ов и маппинг входящих HTTP-запросов в доменную логику.

## Клиентские endpoints

API для клиентов и интеграций должен отвечать за:

- создание job на примерку;
- регистрацию service client при запуске;
- прием heartbeat от service client;
- получение статуса job;
- получение результата обработки;
- отмену job, если сценарий это поддерживает.

## Worker endpoints

API для worker'ов должен отвечать за:

- регистрацию worker'а при запуске;
- прием heartbeat;
- выдачу или подтверждение назначенной job;
- обновление прогресса и финального статуса;
- сообщение об ошибках выполнения.

## Защита worker registration

`POST /workers/register` проверяет `x-worker-key`. Если ключ неверный, coordinator считает ошибку по прямому remote IP. После превышения `WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS` IP получает `403 worker_registration_ip_banned` и остается заблокированным до перезапуска coordinator.

Для бана используется socket remote address, а не `x-forwarded-for`. Заголовки `x-forwarded-for` и `x-real-ip` используются отдельно, только когда coordinator собирает публичный endpoint зарегистрированного worker/client.

## Правила

- В API не должно быть тяжелой бизнес-логики обработки изображений.
- Все входящие payloads валидируются через контракты из `apps/shared/contracts`.
- Ошибки должны возвращаться в едином формате, чтобы client и worker могли одинаково их обрабатывать.
- API key для worker registration и service-to-service операций не должен логироваться.
