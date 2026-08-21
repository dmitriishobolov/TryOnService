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
4. Пока чат ждет фото, выбор образа или результат worker-а, команды вроде `/start`, `/request`, `Анализ внешности` и `Идеальный образ` не переключают сценарий. Бот просит завершить текущий шаг или дождаться результата.
5. На время active job бот скрывает reply keyboard через `remove_keyboard`, чтобы пользователь не сбил интерфейс кнопками меню.
6. Если фото не подходит для почти полного роста, worker возвращает JSON-отказ, а бот просит прислать другое изображение.
7. Если фото подходит, worker возвращает до 3 образов. Бот показывает описание каждого образа и кнопки `Образ 1`, `Образ 2`, `Образ 3`.
8. После выбора образа бот показывает одно редактируемое status-сообщение и дальше обновляет в нем этапы `Поиск товаров`, `Проверка фото`, `Генерация карточек`, вместо серии технических сообщений. Затем бот создает отдельные market jobs по каждому элементу образа и каждому провайдеру: один job для Ozon, один job для Wildberries. Worker получает `payload.market.providers=["ozon"]` или `["wildberries"]`, ищет кандидатов через marketplace adapters и возвращает их в `result.marketProducts`. Если на исходном фото обувь не видна, обувные категории не уходят в поиск.
9. Бот создает OpenAI vision job только после получения API-кандидатов: worker получает найденные `imageUrl` как `payload.model.options.inputImageUrls` и проверяет, можно ли из изображения надежно выделить один целевой товар в чистую карточку. Фото на человеке, модели или манекене допустимо, если форма, цвет, крой и детали предмета хорошо видны.
10. Перед генерацией clean-card бот проверяет storage catalog через coordinator по нормализованной ссылке товара. Если любой зарегистрированный storage-node уже хранит `product-card-image`, бот переиспользует его. Старый client-local путь `clients/<clientId>/product-card-cache/...` остается fallback для локальных cache-файлов.
11. Если карточка уже есть в cache, бот использует ее без нового OpenAI image generation job. Если cache miss, для каждого принятого кандидата бот создает отдельный OpenAI image generation job с `options.imageGeneration` и `toolChoice=required`. Worker генерирует PNG-карточку в portrait canvas: один предмет, фронтальный вид, белый фон, 12-18% свободного поля вокруг вещи, без человека, манекена, других вещей и текста.
12. Worker сохраняет сгенерированную карточку в object storage и возвращает ее в `result.files`. Бот копирует clean-card в product-card cache, регистрирует `product-card-image`/`product-card-metadata` catalog entries, затем скачивает ее из storage и отправляет в Telegram как multipart-файл через `sendPhoto`, поэтому dev/local storage URL вида `localhost` не должен быть публично доступен Telegram. Ссылка на исходную товарную карточку идет в inline-кнопку `Перейти к товару`.
13. Для элементов без надежного кандидата или без сгенерированной карточки бот выводит отдельный список причин.
14. Если пользователь нажал `Отмена` в шаге ожидания фото или выбора образа, бот сбрасывает текущее состояние и возвращает главное меню. Во время уже отправленного job отмена не выполняется и бот просит дождаться результата.
15. Пользователь также может отправить `/request`, `/request openai` или фото с подписью `/request openai` для ручного legacy/demo flow.
16. Telegram client запрашивает assignment через coordinator API и передает `sourceClientId`.
17. Coordinator находит callback URL Telegram client, создает queued job, выбирает worker и отправляет worker-у prepare по этой job, когда capacity доступна.
18. Coordinator возвращает signed dispatch token только после подтверждения worker prepare.
19. Telegram client отправляет `workerRequest` напрямую выбранному worker'у.
20. Worker обрабатывает job и отправляет callback в `POST /callbacks/jobs` с `x-client-callback-token`.
21. Telegram client принимает callback, проверяет token/replay и передает результат в сценарный обработчик бота.

## Реализовано сейчас

- `/start` настраивает команды бота через Telegram Bot API, рассказывает о сервисе и показывает кнопки `Анализ внешности` и `Идеальный образ`.
- `Анализ внешности` переводит чат в состояние ожидания фото с лицом; старая кнопка/команда `Разбор внешности` тоже поддерживается для совместимости.
- `Идеальный образ` переводит чат в состояние ожидания фото почти в полный рост, затем показывает до 3 вариантов образа и запускает поиск товаров по выбранному варианту.
- `Отмена` сбрасывает состояние ожидания фото или выбора образа.
- Пока у чата есть активный session, новые команды не переключают сценарий: бот возвращает пользователя к текущему ожидаемому шагу.
- Пока у чата есть active pending job, любые новые сообщения и команды блокируются до callback-а, а reply keyboard скрывается.
- Фото в сценарии разбора внешности создает OpenAI job с жестким prompt: если это не фото реального человека или лицо не видно, модель должна ответить отказом без анализа.
- Фото в сценарии идеального образа создает OpenAI job со строгим JSON-ответом: `ok=false` для неподходящего фото или `ok=true` с массивом `outfits` и флагом `footwearVisible`.
- По выбранному образу создаются market jobs на worker-е с `payload.market.providers=["ozon"]` или `["wildberries"]`, `payload.market.required=true` и `model.provider=mock`. Coordinator подбирает worker по capabilities `market` и конкретному `market.<provider>`, а worker возвращает найденные товары в `result.marketProducts`.
- После получения API-кандидатов создается отдельный OpenAI vision job с `options.inputImageUrls` и `options.maxInputImageUrls`, чтобы проверить, можно ли из изображения кандидата сгенерировать чистую карточку одного товара.
- Vision-проверка включает `allowInputImagePlaceholders=true`, поэтому битый image URL не останавливает весь образ: worker заменит такую картинку placeholder-ом, а модель отклонит конкретный кандидат.
- OpenAI больше не ищет товары в интернете в сценарии `Идеальный образ`: токены тратятся только на vision-проверку уже найденных API-кандидатов и на image generation. Validation prompt использует compact JSON, `imageDetail=low`, а ответ короткий: `acceptedCandidates` с `canGenerateCleanCard`.
- Если validation job всё равно не вернул JSON или не принял кандидатов уверенно, бот не завершает сценарий сразу: он берет fallback-кандидатов по одному на категорию/slot и пробует clean-card generation по каждому товару отдельно.
- Для market jobs бот отправляет короткую базовую категорию товара, например `брюки`, `рубашка`, `куртка`, `кардиган`, чтобы API-поиск не был слишком узким. Worker market-фильтр расширяет близкие категории вроде `куртка/жакет/пиджак/блейзер`, `брюки/чиносы/джинсы`, а OpenAI vision потом выбирает подходящие изображения.
- Для одного образа бот дополнительно отбраковывает дубли категорий и повторяющиеся ссылки: если уже выбран худи, второй худи в подборку не попадет. Если `footwearVisible=false`, бот вырезает обувь из образа до запуска поиска товаров.
- Для каждого принятого товара бот запускает отдельный OpenAI job с `options.imageGeneration` и `toolChoice=required`, чтобы получить чистое изображение товара на белом фоне.
- Перед запуском такого job бот проверяет product-card cache через `POST /storage/catalog/lookup` по нормализованному `productUrl`. Повторная ссылка товара переиспользует уже сгенерированный PNG с любого доступного storage-node и не тратит новый AI-запрос. После новой генерации бот копирует PNG из `jobs/<jobId>/results/...` в `clients/<clientId>/product-card-cache/...`, сохраняет рядом `.json` metadata с URL товара и регистрирует catalog entries.
- Если по части образа, например куртке, не найден надежный кандидат или не удалось сгенерировать clean card, бот явно показывает этот элемент в списке `Не удалось подобрать качественную карточку`.
- Сгенерированная clean card скачивается ботом из storage и отправляется пользователю через `sendPhoto` multipart upload; короткое описание попадает в caption, ссылка на исходную карточку идет в inline-кнопку `Перейти к товару`.
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
- `Telegram command blocked while session is active` - пользователь попытался переключить сценарий во время активного шага.
- `Telegram update blocked while job is in progress` - пользователь отправил сообщение или команду во время active job.
- `Ideal outfit plan job dispatched` - отправлен job на анализ full-body фото и подбор образов.
- `Ideal outfit market products job dispatched` - отправлен market job на поиск товарных карточек через API Ozon/Wildberries.
- `Ideal outfit product validation job dispatched` - отправлен job на vision-проверку пригодности картинок товаров к clean-card генерации.
- `Ideal outfit clean product card cache hit` - clean-card товара уже есть в storage cache, новый image generation job не запускался.
- `Ideal outfit clean product card catalog cache hit` - clean-card найден через distributed storage catalog на одном из storage-node.
- `Ideal outfit clean product card cache miss` - clean-card товара в storage cache нет, бот продолжит обычную генерацию.
- `Ideal outfit clean product card cached` - fresh clean-card скопирована в storage cache по ссылке товара.
- `Ideal outfit clean product card generation job dispatched` - отправлен job на генерацию чистой карточки товара.
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
