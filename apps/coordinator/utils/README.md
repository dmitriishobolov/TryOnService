# Coordinator Utils

Папка для утилитарных функций coordinator. Сюда выносится код, который нужен coordinator, но не принадлежит напрямую API, registry, jobs или scheduler.

## Что здесь есть сейчас

- `requestAddress.ts` - нормализация remote address, direct socket IP и host для автоопределения публичного endpoint при регистрации worker/client.
- `ipBanGuard.ts` - in-memory guard для бана IP после повторных неверных worker registration ключей.

## Правила

- Утилиты coordinator не должны зависеть от worker/client реализаций.
- Security helpers должны хранить только минимально нужное состояние и не логировать секреты.
- Если helper нужен нескольким приложениям, переносите его в `apps/shared`.
