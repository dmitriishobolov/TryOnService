# Shared Contracts

Папка для контрактов TryOnService: форматов запросов, ответов, статусов и событий, которыми обмениваются coordinator, worker и client.

## Что описывать контрактами

- создание job;
- получение статуса job;
- результат обработки;
- storage object refs для входных и выходных файлов;
- ошибки API;
- регистрацию service client;
- heartbeat service client;
- регистрацию worker;
- heartbeat worker;
- назначение job;
- assignment response для прямой связи client -> worker;
- worker assignment prepare для security handshake coordinator -> worker;
- callback token metadata для прямого ответа worker -> client;
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
- `CreateTryOnJobRequest.sourceClientId` обязателен: jobs создаются только от зарегистрированного service client.
- Статусы jobs и worker'ов должны быть перечислены явно, без неявных строковых литералов в коде приложений.
- Ошибки API возвращаются в формате `ApiErrorResponse`.
