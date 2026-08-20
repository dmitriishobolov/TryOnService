# Shared

`shared` содержит общие части системы, которые используются coordinator, worker и клиентскими интеграциями. Главная зона ответственности - контракты, runtime validators и маленькие helpers, которые фиксируют формат взаимодействия между сервисами.

## Подпапки

- [contracts](contracts/README.md) - DTO, статусы, схемы валидации, request/response contracts.
- [storage](storage/README.md) - общий object storage интерфейс и local backend для dev.

## Файлы верхнего уровня

- `env.ts` - простой загрузчик `.env` без внешней runtime-зависимости.
- `http.ts` - JSON helpers, единый формат API errors, лимит чтения body и `postJson` с timeout/retry.
- `net.ts` - подбор ближайшего свободного порта для сервисов, которые слушают HTTP callback/API.
- `dispatchToken.ts` - создание и проверка signed token для dispatch, callback и storage-access flows; payload содержит `tokenId` и `keyVersion`.
- `tokenReplayGuard.ts` - простой TTL replay guard для одноразовых signed tokens на принимающей стороне.
- `rateLimit.ts` - простой in-memory fixed-window rate limiter для HTTP endpoints.

## Что хранить в shared

- типы jobs и worker'ов;
- enum/status values;
- DTO для API coordinator и worker;
- DTO для object storage refs, storage-node registration и storage-access;
- схемы runtime-валидации;
- общие ошибки и коды ошибок;
- небольшие общие helpers, если они действительно нужны нескольким приложениям, например port discovery, HTTP helpers или token signing.

## Правила

- Shared не должен зависеть от coordinator или worker.
- Изменение публичного контракта должно быть совместимо или сопровождаться версионированием.
- Не переносите сюда код только потому, что он "может пригодиться". Shared должен оставаться маленьким и понятным.
