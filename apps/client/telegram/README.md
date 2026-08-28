# Telegram Client

Папка Telegram-интеграции TryOnService. Здесь находится бот, callback server, HTTP client к coordinator и HTTP client к worker.

Сейчас пользовательских сценария два: `Анализ внешности` и `Идеальный образ`. По `/start` бот показывает обе кнопки, переводит чат в нужное состояние, загружает фото напрямую в storage-node, создает job в coordinator и отправляет heavy request выбранному worker-у напрямую. Legacy/demo команда `/request` сохранена для ручной проверки пайплайна.

Когда запрос содержит фото, Telegram client сначала запрашивает `POST /storage/access`, загружает файл напрямую в storage-node и передает в `POST /jobs` только `StorageObjectRef`.

Для разработки следующих интеграций используйте эту папку как рабочий пример, а общий порядок описан в [инструкции по добавлению нового клиента](../NEW_CLIENT_GUIDE.md).

## Запуск

```powershell
$env:TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
npm run dev:telegram
```

По умолчанию callback server пытается слушать порт `4100`. Если порт занят, Telegram client выберет ближайший свободный порт и зарегистрирует его в coordinator.

Telegram client автоматически регистрируется в coordinator через `POST /clients/register`, передает свой фактический callback-порт и дальше отправляет heartbeat.

## Поток

1. Пользователь открывает `/start`, бот регистрирует меню команд и показывает кнопки `Анализ внешности` и `Идеальный образ`.
2. `Анализ внешности` переводит чат в ожидание фото с видимым лицом. Команда `Разбор внешности` тоже поддерживается как старый алиас.
3. `Идеальный образ` переводит чат в ожидание фото в полный рост или по колено. Если обувь/ноги не видны, worker не выбирает обувь.
4. Бот загружает фото напрямую в storage-node и создает OpenAI job: `appearance-analysis` для разбора внешности или `ideal-outfit` для подбора образа.
5. Coordinator выбирает worker по capabilities. Для `ideal-outfit` worker должен иметь `try-on.openai` и `try-on.pruna`, потому что pipeline сначала выбирает вещи через OpenAI, а затем делает примерку через Pruna.
6. Telegram client отправляет job напрямую на worker endpoint `POST /jobs` с header `x-job-dispatch-token`.
7. Worker обрабатывает job, отправляет progress/result в coordinator и доставляет результат напрямую в `POST /callbacks/jobs` Telegram client-а.
8. Callback server проверяет signed callback token и replay, быстро отвечает worker-у `202 accepted`, а отправку сообщения пользователю выполняет асинхронно.
9. Для `ideal-outfit` бот отправляет итоговую примерку, карточки выбранных вещей и inline-кнопки `Перейти к товару`, если в catalog item есть `productUrl`.

Если coordinator возвращает `202 queued`, бот сообщает пользователю об очереди и вызывает `GET /jobs/:jobId/assignment` до получения assignment-а. Если бот перестал ждать queued job, он вызывает `POST /jobs/:jobId/cancel`, чтобы не оставить старую задачу в голове очереди.

## Реализовано Сейчас

- `/start` настраивает команды Telegram Bot API и показывает кнопки `Анализ внешности` и `Идеальный образ`.
- `Анализ внешности` переводит чат в ожидание фото с лицом.
- `Идеальный образ` переводит чат в ожидание фото в полный рост или по колено, создает job `payload.model.task=ideal-outfit`, а результат показывает как примерку и карточки выбранных вещей.
- `Отмена` сбрасывает ожидание фото и возвращает главное меню.
- Пока у чата есть активный session, новые команды не переключают сценарий: бот возвращает пользователя к текущему ожидаемому шагу.
- Пока у чата есть active pending job, любые новые сообщения и команды блокируются до callback-а, а reply keyboard скрывается.
- Фото создает OpenAI job со строгим prompt: если это не фото реального человека или лицо не видно, модель должна ответить отказом без анализа.
- `/request` создает mock/demo job в coordinator, ждет assignment при очереди и отправляет job worker-у напрямую.
- Фото с подписью `/request openai` загружается в object storage и создает job с `payload.model.provider=openai`.
- Чтобы выбрать конкретную OpenAI-модель из запроса клиента, используйте подпись вида `/request openai:gpt-5.6-luna`.
- Длинные ответы автоматически режутся на несколько Telegram-сообщений.
- Markdown из ответа модели конвертируется в Telegram HTML, поэтому заголовки, `**жирный текст**`, `__жирный текст__`, inline-code и ссылки отображаются форматированно.

## Логи

В devtest логи лежат в `devtest/logs/telegram.log`. Если бот написал `Фото принято... Ожидаю ответ`, ищите события:

- `Appearance analysis job dispatched` - Telegram client отправил job анализа внешности worker-у.
- `Ideal outfit job dispatched` - Telegram client отправил job подбора образа worker-у.
- `Callback request received` - worker дошел до callback endpoint клиента.
- `Callback accepted, scheduling job result handling` - callback принят, token уже отмечен как использованный, worker получит быстрый ACK.
- `Callback handled by Telegram bot` - итоговый callback разобран ботом.
- `Telegram callback handling failed after accept` - callback был принят, но внутренняя отправка сообщения в Telegram упала уже после ACK worker-у.
- `Telegram command blocked while session is active` - пользователь попытался переключить сценарий во время активного шага.
- `Telegram update blocked while job is in progress` - пользователь отправил сообщение или команду во время active job.
- `Queued job still waiting` - throttled-событие ожидания queued assignment; подробные попытки polling пишутся только при `LOG_LEVEL=debug`.
- `Queued coordinator job cancel requested` - бот отменил queued job в coordinator после timeout ожидания.

Если `Appearance analysis job dispatched` нет, проблема до worker dispatch. Если оно есть, а callback-событий нет, смотрите `devtest/logs/worker.log` по тому же `jobId`.

## Правила

- Telegram client не вызывает AI API напрямую.
- Долгие операции должны выполняться worker-ом, а не процессом бота.
- Токен Telegram-бота хранится только в окружении.
- `CLIENT_REGISTRATION_KEY` используется для регистрации клиента, heartbeat и создания assignment в coordinator.
- `CLIENT_CALLBACK_SIGNING_KEY` должен совпадать с coordinator, иначе callback от worker будет отклонен.
- `CLIENT_CALLBACK_SIGNING_KEY_VERSION` должен совпадать с coordinator при текущей версии ключа.
- Все payload'ы к coordinator должны соответствовать контрактам из `apps/shared`.
