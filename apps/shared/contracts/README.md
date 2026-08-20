# Shared Contracts

Папка для контрактов TryOnService: форматов запросов, ответов, статусов и событий, которыми обмениваются coordinator, worker и client.

## Что описывать контрактами

- создание job;
- получение статуса job;
- результат обработки;
- ошибки API;
- регистрацию service client;
- heartbeat service client;
- регистрацию worker;
- heartbeat worker;
- назначение job;
- assignment response для прямой связи client -> worker;
- обновление прогресса;
- capabilities worker'а.

## Рекомендуемый подход

В текущем срезе контракты описаны TypeScript interfaces и ручными runtime validators в `index.ts`. Если проекту понадобится более строгая схема, рядом можно ввести:

- runtime schema для валидации входящих данных;
- TypeScript type, выведенный из schema;
- примеры payload'ов для тестов и документации.

Можно использовать Zod, TypeBox или другой валидатор, если он будет принят как стандарт проекта.

## Правила изменения контрактов

- Сначала меняется contract, затем coordinator/worker/client.
- Удаление поля считается breaking change.
- Новые обязательные поля требуют миграционного плана.
- Статусы jobs и worker'ов должны быть перечислены явно, без неявных строковых литералов в коде приложений.
- Ошибки API возвращаются в формате `ApiErrorResponse`.
