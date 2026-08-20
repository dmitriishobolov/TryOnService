# Scheduler

Scheduler в текущей архитектуре отвечает не за отправку job worker'у, а за housekeeping назначений. Выбор worker'а происходит синхронно в `POST /jobs`, где coordinator возвращает клиенту assignment.

## Задачи scheduler

- находить jobs в статусе `assigned`, которые не перешли в `running` до `JOB_ASSIGNMENT_TIMEOUT_MS`;
- переводить просроченный assignment в `failed`;
- освобождать зарезервированную capacity worker'а;
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

В текущей реализации scheduler работает in-memory и чистит только просроченные assignments. Data-plane остается прямым: client -> worker -> client callback.
