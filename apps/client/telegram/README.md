# Telegram Client

Папка для Telegram-интеграции TryOnService. Здесь находится бот, callback server, HTTP client к coordinator и HTTP client к worker. Сейчас бот показывает главное меню по `/start` с двумя пользовательскими сценариями: `Анализ внешности` и `Идеальный образ`. Также сохранен demo/legacy request по команде `/request`: бот получает assignment или queued-ответ от coordinator, при необходимости polling-ом ждет свободный worker, отправляет job worker'у напрямую и после callback продолжает нужный сценарий или отправляет пользователю текст результата.

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

1. Пользователь открывает `/start`, бот регистрирует меню команд, кратко рассказывает о сервисе и показывает кнопки `Анализ внешности` и `Идеальный образ`.
2. Сценарий `Анализ внешности` просит фото с лицом, загружает его напрямую в storage-node и создает OpenAI job с `payload.model.task=appearance-analysis`.
3. Сценарий `Идеальный образ` просит фото почти в полный рост, загружает его в storage-node и создает OpenAI job с `payload.model.task=wardrobe-recommendation`. Стопы или обувь могут не попадать в кадр.
4. Если фото не подходит для почти полного роста, worker возвращает JSON-отказ, а бот просит прислать другое изображение.
5. Если фото подходит, worker возвращает до 3 образов. Бот показывает описание каждого образа и кнопки `Образ 1`, `Образ 2`, `Образ 3`.
6. После выбора образа бот создает второй OpenAI job с web search: worker ищет несколько кандидатов товарных карточек для каждого элемента образа. Если на исходном фото обувь не видна, обувные категории не уходят в поиск.
7. Бот создает третий OpenAI vision job: worker получает найденные `imageUrl` как `payload.model.options.inputImageUrls` и проверяет, что на фото один товар без человека, манекена, других вещей, коллажей, текста и шумного фона.
8. Бот отправляет пользователю только товары, которые прошли vision-проверку, как фото с кратким описанием и inline-кнопкой `Перейти к товару`. Для элементов без качественной карточки бот выводит отдельный список причин.
9. Если пользователь нажал `Отмена`, бот сбрасывает текущее состояние и возвращает главное меню.
10. Пользователь также может отправить `/request`, `/request openai` или фото с подписью `/request openai` для ручного legacy/demo flow.
11. Telegram client запрашивает assignment через coordinator API и передает `sourceClientId`.
12. Coordinator находит callback URL Telegram client, создает queued job, выбирает worker и отправляет worker-у prepare по этой job, когда capacity доступна.
13. Coordinator возвращает signed dispatch token только после подтверждения worker prepare.
14. Telegram client отправляет `workerRequest` напрямую выбранному worker'у.
15. Worker обрабатывает job и отправляет callback в `POST /callbacks/jobs` с `x-client-callback-token`.
16. Telegram client принимает callback, проверяет token/replay и передает результат в сценарный обработчик бота.

## Реализовано сейчас

- `/start` настраивает команды бота через Telegram Bot API, рассказывает о сервисе и показывает кнопки `Анализ внешности` и `Идеальный образ`.
- `Анализ внешности` переводит чат в состояние ожидания фото с лицом; старая кнопка/команда `Разбор внешности` тоже поддерживается для совместимости.
- `Идеальный образ` переводит чат в состояние ожидания фото почти в полный рост, затем показывает до 3 вариантов образа и запускает поиск товаров по выбранному варианту.
- `Отмена` сбрасывает состояние ожидания фото или выбора образа.
- Фото в сценарии разбора внешности создает OpenAI job с жестким prompt: если это не фото реального человека или лицо не видно, модель должна ответить отказом без анализа.
- Фото в сценарии идеального образа создает OpenAI job со строгим JSON-ответом: `ok=false` для неподходящего фото или `ok=true` с массивом `outfits` и флагом `footwearVisible`.
- По выбранному образу создается второй OpenAI job с `options.webSearch`, чтобы найти кандидаты товарных карточек в интернете.
- После web search создается отдельный OpenAI vision job с `options.inputImageUrls`, чтобы проверить изображения кандидатов до отправки пользователю.
- Для одного образа бот дополнительно отбраковывает дубли категорий и повторяющиеся ссылки: если уже выбран худи, второй худи в подборку не попадет. Если `footwearVisible=false`, бот вырезает обувь из образа до запуска поиска товаров.
- Финальная выдача принимает товар только если `imageCheck.approved=true` и все флаги `productOnly`, `noPerson`, `noMannequin`, `noOtherClothes`, `cleanBackground`, `fullyVisible`, `noTextOverlay` истинны.
- Если по части образа, например куртке, не найдено чистое фото товара, бот явно показывает этот элемент в списке `Не удалось подобрать качественную карточку`.
- Товар отправляется пользователю через `sendPhoto`, короткое описание попадает в caption, ссылка на карточку идет в inline-кнопку `Перейти к товару`.
- `/request` создает mock/demo job в coordinator, ждет assignment при очереди и отправляет job worker'у напрямую.
- Фото с подписью `/request openai` загружается в object storage и создает job с `payload.model.provider=openai`.
- Чтобы выбрать конкретную OpenAI-модель из запроса клиента, используйте подпись вида `/request openai:gpt-5.6-luna`.
- HTTP client умеет запросить storage-access у coordinator для загрузки пользовательских фото.
- client registration и heartbeat в coordinator.
- автоматический выбор ближайшего свободного callback-порта.
- `POST /callbacks/jobs` проверяет signed callback token по `CLIENT_CALLBACK_SIGNING_KEY`, `CLIENT_CALLBACK_SIGNING_KEY_VERSION` и одноразовому `tokenId`, принимает ответ worker'а и передает его в обработчик текущего сценария Telegram bot.
- длинные ответы автоматически режутся на несколько Telegram-сообщений;
- Markdown из ответа модели конвертируется в Telegram HTML, поэтому заголовки, `**жирный текст**`, `__жирный текст__`, inline-code и ссылки отображаются форматированно.

## Логи

В devtest логи лежат в `devtest/logs/telegram.log`. Если бот написал `Фото принято... Ожидаю ответ`, ищите события:

- `Appearance analysis job dispatched` - Telegram client отправил job worker-у.
- `Callback request received` - worker дошел до callback endpoint клиента.
- `Callback handled by Telegram bot` - итоговый callback разобран ботом; дальше ищите события конкретного сценария.
- `Ideal outfit plan job dispatched` - отправлен job на анализ full-body фото и подбор образов.
- `Ideal outfit products job dispatched` - отправлен job на web search товарных карточек.
- `Ideal outfit product validation job dispatched` - отправлен job на vision-проверку картинок товаров.
- `Ideal outfit products delivered` - товары отправлены пользователю.

Если первого события нет, проблема до worker dispatch. Если первое есть, а callback-событий нет, смотрите `devtest/logs/worker.log` по тому же `jobId`.

## Правила

- Telegram client не вызывает AI API напрямую.
- Долгие операции должны выполняться worker'ом, а не процессом бота.
- Токен Telegram-бота хранится только в окружении.
- `CLIENT_REGISTRATION_KEY` используется для регистрации клиента, heartbeat и создания assignment в coordinator.
- `CLIENT_CALLBACK_SIGNING_KEY` должен совпадать с coordinator, иначе callback от worker будет отклонен.
- `CLIENT_CALLBACK_SIGNING_KEY_VERSION` должен совпадать с coordinator при текущей версии ключа.
- Все payload'ы к coordinator должны соответствовать контрактам из `apps/shared`.
