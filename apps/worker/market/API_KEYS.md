# Marketplace API Keys

Эта инструкция описывает, где получить ключи для marketplace adapters worker-а и какие значения внести в `.env`.

Секреты не хранятся в git. Заполняйте локальный `.env`, secret manager или env-файл окружения, из которого собирается deploy-пакет через `BUILD_ENV_FILE`.

## Ozon Seller API

Worker использует:

```env
OZON_CLIENT_ID=
OZON_API_KEY=
```

Как получить:

1. Войдите в личный кабинет продавца Ozon: `https://seller.ozon.ru`.
2. Откройте раздел `Настройки -> Seller API` или `Настройки -> API ключи -> Seller API`.
3. Скопируйте `Client ID` и внесите его в `OZON_CLIENT_ID`.
4. Нажмите `Сгенерировать ключ`.
5. Задайте понятное название, например `TryOnService worker`.
6. Выберите права, которые дают чтение товарного каталога. Для текущего adapter-а нужны методы списка товаров и информации о товарах (`/v3/product/list`, `/v3/product/info/list`). Если кабинет не показывает точную роль для product read-only, для первого dev-подключения можно использовать `Admin read only`, а затем сузить права.
7. Сгенерируйте ключ, сразу скопируйте его и внесите в `OZON_API_KEY`. Обычно ключ показывается только один раз.
8. Поставьте напоминание на ротацию ключа. По сообщению Ozon for dev, новые Seller API keys с 13.02.2026 имеют срок действия 180 дней.

Проверка:

```powershell
curl.exe -s -X POST "https://api-seller.ozon.ru/v3/product/list" `
  -H "Client-Id: <OZON_CLIENT_ID>" `
  -H "Api-Key: <OZON_API_KEY>" `
  -H "Content-Type: application/json" `
  --data '{"filter":{"visibility":"VISIBLE"},"limit":1}'
```

## Wildberries Content API

Worker использует:

```env
WILDBERRIES_API_KEY=
```

Как получить:

1. Войдите в кабинет продавца WB Partners: `https://seller.wildberries.ru`.
2. Откройте `Профиль -> Интеграции по API`.
3. Нажмите `+ Создать токен`.
4. Для собственного worker-а выберите вкладку `Для интеграции вручную`.
5. Выберите тип токена:
   - `Персональный токен` - рекомендуемый вариант для собственного сервера/worker-а.
   - `Базовый токен` - можно использовать для ограниченных тестов, если ему хватает категории данных.
   - `Тестовый токен` - только для песочницы, не даст доступ к реальным карточкам магазина.
6. Выберите категорию API `Контент` и уровень доступа `Только чтение`. Текущий adapter читает список карточек через Content API.
7. Создайте токен, сразу скопируйте его и внесите в `WILDBERRIES_API_KEY`. WB показывает токен только один раз.
8. Поставьте напоминание на ротацию. В справке WB указано, что токены действуют 180 дней.

Проверка:

```powershell
curl.exe -s -X POST "https://content-api.wildberries.ru/content/v2/get/cards/list" `
  -H "Authorization: <WILDBERRIES_API_KEY>" `
  -H "Content-Type: application/json" `
  --data '{"settings":{"cursor":{"limit":1},"filter":{"withPhoto":1}}}'
```

## AliExpress Open Platform / Affiliate API

Worker использует:

```env
ALIEXPRESS_APP_KEY=
ALIEXPRESS_APP_SECRET=
ALIEXPRESS_APP_SIGNATURE=
ALIEXPRESS_TRACKING_ID=
```

Обязательные для текущего adapter-а:

- `ALIEXPRESS_APP_KEY`
- `ALIEXPRESS_APP_SECRET`

Опциональные:

- `ALIEXPRESS_APP_SIGNATURE` - если требуется вашим app/affiliate setup.
- `ALIEXPRESS_TRACKING_ID` - tracking id affiliate-канала, если он выдан для вашей программы.

Как получить:

1. Зарегистрируйтесь или войдите в AliExpress Open Platform: `https://open.aliexpress.com`.
2. Создайте developer account и заполните профиль разработчика. Для публикации и production-доступа профиль должен пройти review.
3. В `APP Console` нажмите `Create` и выберите категорию приложения:
   - `Individual Developer` - для собственного магазина/внутреннего использования.
   - `Commercial Developer` - для ISV/сервиса, который работает с другими продавцами.
4. Подайте заявку на категорию приложения и дождитесь approval.
5. После approval нажмите `Create App`, заполните название, callback URL и остальные данные приложения.
6. Откройте `APP Overview`: там отображается `App Key`. В блоке `Basic Information` нажмите `View`, чтобы посмотреть `App Secret`.
7. Внесите значения в `ALIEXPRESS_APP_KEY` и `ALIEXPRESS_APP_SECRET`.
8. В разделе `API Permission Group` запросите доступ к нужной группе API. Для текущего adapter-а нужен доступ к product/affiliate search API, который позволяет вызывать `aliexpress.affiliate.product.query`.
9. Если вам нужен доступ к данным конкретного продавца, настройте OAuth seller authorization. Для affiliate product query это может не требоваться, но для seller business data требуется access token.
10. Если в вашем affiliate setup есть tracking id или app signature, внесите их в `ALIEXPRESS_TRACKING_ID` и `ALIEXPRESS_APP_SIGNATURE`.

Проверка в нашем worker-е удобнее через devtest/job, потому что AliExpress TOP API требует корректной подписи (`sign`) на каждый запрос. Adapter сам подписывает запрос через `ALIEXPRESS_APP_SECRET` и `ALIEXPRESS_SIGN_METHOD`.

## Что перезапустить после добавления ключей

1. Обновите локальный `.env` или env-файл сборки.
2. Перезапустите worker.
3. Убедитесь, что worker зарегистрировал capabilities:
   - `market.aliexpress`
   - `market.ozon`
   - `market.wildberries`
4. Если собираете deploy-пакет, запустите:

```bash
npm run build:dist
```

`dist/packages/worker/.env` должен содержать новые значения, потому что marketplace env keys уже добавлены в build whitelist.

## Безопасность

- Не передавайте marketplace keys клиентам. Они должны жить только в worker env.
- Для Ozon и Wildberries по возможности используйте read-only права, потому что текущий worker только читает карточки и фото.
- Храните ключи в secret manager или защищенном `.env` на сервере.
- Сразу ротируйте ключ при подозрении на утечку.
- Не отправляйте реальные ключи в чат, issue tracker или git.

## Полезные ссылки

- Ozon Seller API docs: https://docs.ozon.ru/api/seller/
- Ozon Seller API key rotation news: https://dev.ozon.ru/news/649-Obnovlenie-pravil-raboty-s-API-kliuchami-Vazhnye-izmeneniia-v-rabote-s-Ozon-Seller-API/
- Wildberries token guide: https://seller.wildberries.ru/instructions/ru/by/material/how-to-create-update-or-delete-a-wb-api-token
- Wildberries API information: https://dev.wildberries.ru/ru/openapi/api-information
- AliExpress Open Platform getting started: https://developer.alibaba.com/docs/doc.htm?articleId=120672&docType=1&treeId=727
- AliExpress register application: https://developer.alibaba.com/docs/doc.htm?articleId=120674&docType=1&treeId=727
- AliExpress retrieve App Key and App Secret: https://developer.alibaba.com/docs/doc.htm?articleId=120675&docType=1&treeId=727
- AliExpress request API permission: https://developer.alibaba.com/docs/doc.htm?articleId=120676&docType=1&treeId=727
- AliExpress signature algorithm: https://developer.alibaba.com/docs/doc.htm?articleId=120692&docType=1&treeId=727

