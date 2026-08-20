# Telegram Client

Папка для Telegram-интеграции TryOnService. Здесь будет код бота или сервиса, который принимает фотографии и параметры от пользователя, создает job в coordinator и возвращает статус/результат.

## Запуск

```powershell
$env:TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
npm run dev:telegram
```

По умолчанию callback server пытается слушать порт `4100`. Если порт занят, Telegram client выберет ближайший свободный порт и зарегистрирует его в coordinator.

Telegram client автоматически регистрируется в coordinator через `POST /clients/register`, передает свой фактический callback-порт и дальше отправляет heartbeat.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/telegram-client`.

## Ожидаемый поток

1. Пользователь отправляет фотографии и выбирает сценарий примерки.
2. Telegram client валидирует минимальные требования к вводу.
3. Client создает job через coordinator API.
4. Пользователь получает сообщение о постановке задачи в очередь.
5. Client периодически проверяет статус или получает callback.
6. Когда job завершена, пользователю отправляется результат.

## Реализовано сейчас

- `/start` настраивает команды бота через Telegram Bot API и показывает кнопку `Request`.
- `/request` или кнопка `Request` создают job в coordinator.
- `POST /callbacks/jobs` принимает ответ worker'а и отправляет пользователю текст результата.

## Правила

- Telegram client не вызывает AI API напрямую.
- Долгие операции должны выполняться worker'ом, а не процессом бота.
- Токен Telegram-бота хранится только в окружении.
- Все payload'ы к coordinator должны соответствовать контрактам из `apps/shared`.
