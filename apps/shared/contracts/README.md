# Shared Contracts

Папка для контрактов TryOnService: форматов запросов, ответов, статусов и событий, которыми обмениваются coordinator, worker и client.

## Что описывать контрактами

- создание job;
- выбор AI provider-а, provider model и provider-specific options в `CreateTryOnJobRequest.payload.model`;
- выбор marketplace provider-ов и параметров поиска одежды в `CreateTryOnJobRequest.payload.market`;
- получение статуса job;
- результат обработки, включая `TryOnJobResult.marketProducts` для найденных marketplace-товаров;
- storage object refs для входных и выходных файлов, включая `storageId` узла, где лежит объект;
- регистрацию storage-node, heartbeat storage-node и выдачу storage-access;
- ошибки API;
- регистрацию service client;
- heartbeat service client;
- регистрацию worker;
- heartbeat worker;
- назначение job;
- assignment/queued response для прямой связи client -> worker или ожидания capacity;
- worker assignment prepare для security handshake coordinator -> worker;
- worker cancel response для pending/running отмены;
- callback token metadata для прямого ответа worker -> client;
- storage-access token metadata для прямого upload/download client/worker -> storage-node;
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
- Новый AI provider сначала добавляется в `TryOnModelProvider` и `isTryOnModelProvider`; новый marketplace provider - в `MarketProvider` и `isMarketProvider`.
- `CreateTryOnJobRequest.sourceClientId` обязателен: jobs создаются только от зарегистрированного service client.
- Статусы jobs и worker'ов должны быть перечислены явно, без неявных строковых литералов в коде приложений.
- `delivery_failed` означает, что обработка завершилась и `result` есть, но callback клиенту не доставлен.
- Ошибки API возвращаются в формате `ApiErrorResponse`.
