# Worker API

Папка для кода, который связывает worker с coordinator и клиентами. Сейчас здесь есть HTTP client к coordinator и локальный HTTP endpoint worker'а для прямого приема jobs от клиентов.

## Основные операции

- регистрация worker'а в coordinator;
- отправка heartbeat;
- прием `POST /assignments` от coordinator для подготовки будущего client dispatch;
- прием `POST /jobs` от клиента по `x-job-dispatch-token`;
- прием `POST /jobs/:jobId/cancel` от coordinator для отмены pending assignment;
- отправка прогресса выполнения;
- отправка финального результата;
- отправка структурированной ошибки.

## Правила

- Все запросы к coordinator должны иметь таймауты и retries с backoff.
- Секреты и registration key нельзя логировать.
- Worker registration key и service key не передаются клиентам; client приносит signed dispatch token, который worker проверяет локально.
- `POST /assignments`, `GET /health` и `POST /jobs/:jobId/cancel` защищены `x-worker-service-key`.
- `POST /jobs` не принимает service key как обходной доступ: нужен `x-job-dispatch-token` с purpose `worker-dispatch`.
- Callback к service client отправляется с `x-client-callback-token`, полученным от coordinator при prepare.
- Signed dispatch token сам по себе недостаточен: worker также требует заранее подготовленный pending assignment.
- Pending assignments учитываются как занятые slots, чтобы coordinator видел реальную нагрузку сети.
- Сетевые ошибки не должны падать неуправляемо внутри runner: API слой должен возвращать понятную ошибку.
- Форматы запросов и ответов берутся из `apps/shared/contracts`.
