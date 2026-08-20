# Scheduler

Scheduler в текущей архитектуре отвечает не за отправку job worker'у, а за housekeeping назначений. Выбор worker'а происходит в `POST /jobs` или `GET /jobs/:jobId/assignment`, где coordinator возвращает клиенту assignment или queued-ответ.

## Задачи scheduler

- находить jobs в статусе `assigned`, которые не перешли в `running` до `JOB_ASSIGNMENT_TIMEOUT_MS`;
- возвращать просроченный assignment в `queued`, если cancel на worker-е подтвержден;
- отправлять worker-у cancel для pending/running assignment;
- освобождать зарезервированную capacity worker'а только после подтвержденной отмены;
- логировать просрочки assignment.

## Где выбирается worker

Worker выбирается в coordinator API по минимальным критериям:

- worker активен и не просрочил heartbeat;
- у worker есть свободная capacity;
- capabilities worker'а позволяют выполнить job.

## Правила

- Логика scheduler должна быть отделена от HTTP API.
- Assignment job должно быть атомарным: одна job не должна получить два worker'а.
- Retry policy должна быть явной и наблюдаемой через логи/метрики.

В текущей реализации scheduler работает поверх выбранного persistence backend и чистит только просроченные assignments. Data-plane остается прямым: client -> worker -> client callback.
