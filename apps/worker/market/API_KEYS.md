# Marketplace Credentials

Эта инструкция описывает, где нужны ключи для marketplace adapters worker-а и какие значения внести в `.env`.

Секреты не хранятся в git. Заполняйте локальный `.env`, secret manager или env-файл окружения, из которого собирается deploy-пакет через `BUILD_ENV_FILE`.

## Ozon

Текущий Ozon adapter больше не использует Seller API keys. Он работает как public page parser:

```env
OZON_PUBLIC_SEARCH_BASE_URL=https://www.ozon.ru/search/
OZON_PUBLIC_PRODUCT_BASE_URL=https://www.ozon.ru
OZON_PUBLIC_SEARCH_PAGES=1
OZON_MAX_SCAN_PRODUCTS=12
```

Parser открывает HTML страницы поиска, извлекает ссылки `/product/`, затем читает карточки товара из HTML/JSON-LD/meta. Ozon может возвращать redirect-loop или anti-bot страницу; worker не использует stealth, proxy rotation или captcha bypass, а вместо этого включает cooldown и использует stale-cache, если он уже есть.

## Wildberries

Текущий Wildberries adapter больше не использует Content API token. Он работает как public catalog parser:

```env
WILDBERRIES_PUBLIC_SEARCH_BASE_URL=https://search.wb.ru
WILDBERRIES_PUBLIC_SEARCH_PATH=/exactmatch/ru/common/v18/search
WILDBERRIES_PUBLIC_DEST=-1257786
```

Parser получает JSON выдачу, нормализует `id`, `name`, `brand`, `sizes[0].price.product`, `rating`, `feedbacks`, строит ссылку на товар и image URL через WB basket CDN. Ключ WB seller кабинета для этого сценария не нужен.

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
   - `market.ozon` (ключи не нужны)
   - `market.wildberries` (ключи не нужны)
4. Если собираете deploy-пакет, запустите:

```bash
npm run build:dist
```

`dist/packages/worker/.env` должен содержать новые значения, потому что marketplace env keys уже добавлены в build whitelist.

## Безопасность

- Не передавайте marketplace keys клиентам. Если provider требует keys, они должны жить только в worker env.
- Для Ozon/Wildberries текущие public parsers не используют seller keys.
- Храните ключи в secret manager или защищенном `.env` на сервере.
- Сразу ротируйте ключ при подозрении на утечку.
- Не отправляйте реальные ключи в чат, issue tracker или git.

## Полезные ссылки

- Ozon public parsing article: https://habr.com/ru/companies/amvera/articles/960280/
- Wildberries public parsing article: https://habr.com/ru/companies/amvera/articles/948988/
- AliExpress Open Platform getting started: https://developer.alibaba.com/docs/doc.htm?articleId=120672&docType=1&treeId=727
- AliExpress register application: https://developer.alibaba.com/docs/doc.htm?articleId=120674&docType=1&treeId=727
- AliExpress retrieve App Key and App Secret: https://developer.alibaba.com/docs/doc.htm?articleId=120675&docType=1&treeId=727
- AliExpress request API permission: https://developer.alibaba.com/docs/doc.htm?articleId=120676&docType=1&treeId=727
- AliExpress signature algorithm: https://developer.alibaba.com/docs/doc.htm?articleId=120692&docType=1&treeId=727
