# Telegram Client

Папка для Telegram-интеграции TryOnService. Здесь находится бот, callback server и HTTP client к coordinator. Сейчас бот создает demo job по команде `/request` или кнопке `Request`, а после обработки отправляет пользователю текст результата.

## Запуск

```powershell
$env:TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
npm run dev:telegram
```

По умолчанию callback server пытается слушать порт `4100`. Если порт занят, Telegram client выберет ближайший свободный порт и зарегистрирует его в coordinator.

Telegram client автоматически регистрируется в coordinator через `POST /clients/register`, передает свой фактический callback-порт и дальше отправляет heartbeat.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/telegram-client`.

## Ожидаемый поток

1. Пользователь открывает `/start`, бот регистрирует меню команд и показывает кнопку `Request`.
2. Пользователь отправляет `/request` или нажимает кнопку.
3. Telegram client создает job через coordinator API и передает `sourceClientId`.
4. Coordinator находит callback URL зарегистрированного Telegram client.
5. Worker обрабатывает job и отправляет callback в `POST /callbacks/jobs`.
6. Telegram client отправляет пользователю сообщение `Ответ от сервера.`.

## Реализовано сейчас

- `/start` настраивает команды бота через Telegram Bot API и показывает кнопку `Request`.
- `/request` или кнопка `Request` создают job в coordinator.
- client registration и heartbeat в coordinator.
- автоматический выбор ближайшего свободного callback-порта.
- `POST /callbacks/jobs` принимает ответ worker'а и отправляет пользователю текст результата.

## Правила

- Telegram client не вызывает AI API напрямую.
- Долгие операции должны выполняться worker'ом, а не процессом бота.
- Токен Telegram-бота хранится только в окружении.
- Все payload'ы к coordinator должны соответствовать контрактам из `apps/shared`.
