# Catalog Browser

Здесь лежит тонкий Playwright-слой для parser provider-ов. Он нужен не для бизнес-логики, а для базового чтения страниц, где обычного `fetch` мало из-за client-side rendering.

## pageReader.ts

`readCatalogPage(options)` делает минимум:

- запускает Chromium через Playwright;
- открывает URL;
- ждет `load`, `domcontentloaded` или `networkidle`;
- возвращает final URL, status, title, полный HTML, обрезанный body text и первые ссылки.

Пример использования внутри parser-а:

```ts
const page = await readCatalogPage({
  url: "https://example.com/catalog",
  userAgent: context.userAgent,
  headless: true,
  timeoutMs: 30_000,
  waitUntil: "domcontentloaded",
  textMaxChars: 20_000,
  linksMaxCount: 100,
});
```

Сам helper не пишет товары в storage. Parser должен сам разобрать `page.html`, `page.text` или `page.links`, собрать `CatalogGarmentDraft[]` и вернуть их общему pipeline.

## Browser runtime

Playwright установлен как dependency проекта. На новой машине перед первым запуском browser-парсера установите Chromium:

```bash
npx playwright install chromium
```

В deploy-пакете `catalog-ingestor` node_modules копируются вместе с сервисом, но системный browser runtime может потребовать отдельной установки Chromium на конкретном сервере.
