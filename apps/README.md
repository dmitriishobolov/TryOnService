# Apps

Папка `apps` содержит все приложения и общие пакеты TryOnService. Структура ориентирована на Node.js + TypeScript монорепозиторий: каждый верхнеуровневый модуль отвечает за отдельную часть системы и имеет явные публичные контракты.

## Модули

- [coordinator](coordinator/README.md) - центральный сервис, который хранит jobs, регистрирует worker'ы/service clients/storage-node, ведет storage registry и выдает клиентам worker assignment.
- [storage](storage/README.md) - object storage node, который сам регистрируется в coordinator и принимает прямой upload/download файлов от клиентов и worker'ов.
- [worker](worker/README.md) - исполняющий сервис, который запускается на отдельных серверах, регистрируется в coordinator, выполняет обработку через AI API adapters и при необходимости подбирает товары через marketplace adapters.
- [shared](shared/README.md) - общие типы, DTO, runtime validators и helpers между сервисами.
- [client](client/README.md) - клиентские интеграции и каналы, через которые пользователи создают запросы на примерку и получают результат.

## Правило границ

Код coordinator не должен напрямую зависеть от внутренних реализаций worker и не должен быть каналом передачи клиентского результата или файлов. Client отвечает за прямую отправку job назначенному worker'у и прямой upload входных файлов в storage-node, но не содержит бизнес-логику обработки примерки. Worker читает входные файлы и пишет результаты через storage-node, получая доступ от coordinator. Postgres credentials остаются только у coordinator. Файлы передаются между сервисами как object storage refs. Все общие форматы данных выносите в `shared`, чтобы контракты между сервисами оставались явными.
