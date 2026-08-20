# Telegram Client

Папка для Telegram-интеграции TryOnService. Здесь находится бот, callback server, HTTP client к coordinator и HTTP client к worker. Сейчас бот создает demo request по команде `/request` или кнопке `Request`, получает assignment от coordinator, отправляет job worker'у напрямую и после callback отправляет пользователю текст результата.

## Запуск

```powershell
$env:TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
npm run dev:telegram
```

По умолчанию callback server пытается слушать порт `4100`. Если порт занят, Telegram client выберет ближайший свободный порт и зарегистрирует его в coordinator.

Telegram client автоматически регистрируется в coordinator через `POST /clients/register`, передает свой фактический callback-порт и дальше отправляет heartbeat.

Для обработки запроса Telegram client вызывает `POST /jobs` coordinator. Coordinator выбирает worker и заранее готовит assignment на worker-е. После этого Telegram client получает выбранный worker, `workerRequest` и `dispatchToken`, затем отправляет `POST /jobs` напрямую на worker endpoint с header `x-job-dispatch-token`.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/telegram-client`.

## Ожидаемый поток

1. Пользователь открывает `/start`, бот регистрирует меню команд и показывает кнопку `Request`.
2. Пользователь отправляет `/request` или нажимает кнопку.
3. Telegram client запрашивает assignment через coordinator API и передает `sourceClientId`.
4. Coordinator находит callback URL Telegram client, выбирает worker и отправляет worker-у prepare по этой job.
5. Coordinator возвращает signed dispatch token только после подтверждения worker prepare.
6. Telegram client отправляет `workerRequest` напрямую выбранному worker'у.
7. Worker обрабатывает job и отправляет callback в `POST /callbacks/jobs` с `x-client-callback-token`.
8. Telegram client отправляет пользователю сообщение `Ответ от сервера.`.

## Реализовано сейчас

- `/start` настраивает команды бота через Telegram Bot API и показывает кнопку `Request`.
- `/request` или кнопка `Request` создают assignment в coordinator и отправляют job worker'у напрямую.
- client registration и heartbeat в coordinator.
- автоматический выбор ближайшего свободного callback-порта.
- `POST /callbacks/jobs` проверяет signed callback token по `CLIENT_CALLBACK_SIGNING_KEY`, принимает ответ worker'а и отправляет пользователю текст результата.

## Правила

- Telegram client не вызывает AI API напрямую.
- Долгие операции должны выполняться worker'ом, а не процессом бота.
- Токен Telegram-бота хранится только в окружении.
- `CLIENT_REGISTRATION_KEY` защищает регистрацию клиента и создание assignment в coordinator.
- `CLIENT_CALLBACK_SIGNING_KEY` должен совпадать с coordinator, иначе callback от worker будет отклонен.
- Все payload'ы к coordinator должны соответствовать контрактам из `apps/shared`.
