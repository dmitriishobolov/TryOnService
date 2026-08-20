# Telegram Client

Папка для Telegram-интеграции TryOnService. Здесь находится бот, callback server, HTTP client к coordinator и HTTP client к worker. Сейчас бот показывает сценарий разбора внешности по `/start`, создает demo request по команде `/request`, умеет отправлять фото с подписью `/request openai` для OpenAI/ChatGPT анализа, получает assignment или queued-ответ от coordinator, при необходимости polling-ом ждет свободный worker, отправляет job worker'у напрямую и после callback отправляет пользователю текст результата.

Когда запрос содержит фото, Telegram client сначала запрашивает `POST /storage/access`, загружает файл напрямую в storage-node и передает в `POST /jobs` только `StorageObjectRef`.

Для разработки следующих интеграций используйте эту папку как рабочий пример, а общий порядок описан в [инструкции по добавлению нового клиента](../NEW_CLIENT_GUIDE.md).

## Запуск

```powershell
$env:TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
npm run dev:telegram
```

По умолчанию callback server пытается слушать порт `4100`. Если порт занят, Telegram client выберет ближайший свободный порт и зарегистрирует его в coordinator.

Telegram client автоматически регистрируется в coordinator через `POST /clients/register`, передает свой фактический callback-порт и дальше отправляет heartbeat.

Для обработки запроса Telegram client вызывает `POST /jobs` coordinator. Coordinator выбирает worker и заранее готовит assignment на worker-е. После этого Telegram client получает выбранный worker, `workerRequest` и `dispatchToken`, затем отправляет `POST /jobs` напрямую на worker endpoint с header `x-job-dispatch-token`. Если coordinator возвращает `202 queued`, бот сообщает пользователю об очереди и вызывает `GET /jobs/:jobId/assignment` до получения assignment-а.

Deploy-пакет собирается командой `npm run build:dist` в `dist/packages/telegram-client`.

## Ожидаемый поток

1. Пользователь открывает `/start`, бот регистрирует меню команд и спрашивает: `Хотите сделать разбор вашей внешности?`.
2. Пользователь нажимает кнопку `Разбор внешности`, после чего бот просит отправить изображение с лицом и показывает кнопку `Отмена`.
3. Пользователь отправляет фото; Telegram client загружает его напрямую в storage-node и создает OpenAI job с `payload.model.task=appearance-analysis`.
4. Если пользователь нажал `Отмена`, бот сбрасывает состояние ожидания фото и возвращает главное меню.
5. Пользователь также может отправить `/request`, `/request openai` или фото с подписью `/request openai` для ручного legacy/demo flow.
6. Telegram client запрашивает assignment через coordinator API и передает `sourceClientId`.
7. Coordinator находит callback URL Telegram client, создает queued job, выбирает worker и отправляет worker-у prepare по этой job, когда capacity доступна.
8. Coordinator возвращает signed dispatch token только после подтверждения worker prepare.
9. Telegram client отправляет `workerRequest` напрямую выбранному worker'у.
10. Worker обрабатывает job и отправляет callback в `POST /callbacks/jobs` с `x-client-callback-token`.
11. Telegram client отправляет пользователю сообщение с ответом worker'а.

## Реализовано сейчас

- `/start` настраивает команды бота через Telegram Bot API, предлагает разбор внешности и показывает кнопку `Разбор внешности`.
- `Разбор внешности` переводит чат в состояние ожидания фото; `Отмена` сбрасывает это состояние.
- Фото в сценарии разбора внешности создает OpenAI job с жестким prompt: если это не фото реального человека или лицо не видно, модель должна ответить отказом без анализа.
- `/request` создает mock/demo job в coordinator, ждет assignment при очереди и отправляет job worker'у напрямую.
- Фото с подписью `/request openai` загружается в object storage и создает job с `payload.model.provider=openai`.
- Чтобы выбрать конкретную OpenAI-модель из запроса клиента, используйте подпись вида `/request openai:gpt-5.6-luna`.
- HTTP client умеет запросить storage-access у coordinator для загрузки пользовательских фото.
- client registration и heartbeat в coordinator.
- автоматический выбор ближайшего свободного callback-порта.
- `POST /callbacks/jobs` проверяет signed callback token по `CLIENT_CALLBACK_SIGNING_KEY`, `CLIENT_CALLBACK_SIGNING_KEY_VERSION` и одноразовому `tokenId`, принимает ответ worker'а и отправляет пользователю текст результата.

## Логи

В devtest логи лежат в `devtest/logs/telegram.log`. Если бот написал `Фото принято... Ожидаю ответ`, ищите события:

- `Appearance analysis job dispatched` - Telegram client отправил job worker-у.
- `Callback request received` - worker дошел до callback endpoint клиента.
- `Callback delivered to Telegram chat` - итоговое сообщение отправлено пользователю.

Если первого события нет, проблема до worker dispatch. Если первое есть, а callback-событий нет, смотрите `devtest/logs/worker.log` по тому же `jobId`.

## Правила

- Telegram client не вызывает AI API напрямую.
- Долгие операции должны выполняться worker'ом, а не процессом бота.
- Токен Telegram-бота хранится только в окружении.
- `CLIENT_REGISTRATION_KEY` используется для регистрации клиента, heartbeat и создания assignment в coordinator.
- `CLIENT_CALLBACK_SIGNING_KEY` должен совпадать с coordinator, иначе callback от worker будет отклонен.
- `CLIENT_CALLBACK_SIGNING_KEY_VERSION` должен совпадать с coordinator при текущей версии ключа.
- Все payload'ы к coordinator должны соответствовать контрактам из `apps/shared`.
