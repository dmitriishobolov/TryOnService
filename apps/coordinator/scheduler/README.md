# Scheduler

Scheduler отвечает за выбор worker'а для job и контроль выполнения назначенных задач. Он связывает очередь jobs с registry доступных worker'ов.

## Задачи scheduler

- находить jobs в статусе `queued`;
- выбирать worker по availability, capacity и capabilities;
- назначать job worker'у;
- отслеживать timeouts и зависшие назначения;
- возвращать job в очередь или переводить в `failed`, если retry limit исчерпан.

## Критерии выбора worker

Минимальный вариант выбора:

- worker активен и не просрочил heartbeat;
- worker поддерживает нужный тип обработки;
- у worker есть свободная capacity;
- job не превышает лимиты worker'а.

## Правила

- Логика scheduler должна быть отделена от HTTP API.
- Назначение job должно быть атомарным: одна job не должна уйти двум worker'ам.
- Retry policy должна быть явной и наблюдаемой через логи/метрики.
