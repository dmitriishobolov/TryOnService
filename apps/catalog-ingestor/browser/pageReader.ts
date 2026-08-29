import { chromium, type Browser, type Page } from "playwright";

import type { CatalogBrowserWaitUntil } from "../catalog/types.js";

export interface CatalogPageReaderOptions {
  url: string;
  userAgent: string;
  headless: boolean;
  timeoutMs: number;
  waitUntil: CatalogBrowserWaitUntil;
  textMaxChars: number;
  linksMaxCount: number;
}

export interface CatalogPageLink {
  text: string;
  href: string;
}

export interface CatalogPageSnapshot {
  requestedUrl: string;
  url: string;
  status?: number;
  ok?: boolean;
  title: string;
  html: string;
  text: string;
  links: CatalogPageLink[];
}

export async function readCatalogPage(
  options: CatalogPageReaderOptions,
): Promise<CatalogPageSnapshot> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: options.headless });
    const page = await browser.newPage({ userAgent: options.userAgent });
    page.setDefaultTimeout(options.timeoutMs);

    const response = await page.goto(options.url, {
      waitUntil: options.waitUntil,
      timeout: options.timeoutMs,
    });
    await settlePage(page, options.timeoutMs);

    const [title, html, text, links] = await Promise.all([
      page.title(),
      page.content(),
      readBodyText(page, options.textMaxChars),
      readLinks(page, options.linksMaxCount),
    ]);

    return {
      requestedUrl: options.url,
      url: page.url(),
      status: response?.status(),
      ok: response?.ok(),
      title,
      html,
      text,
      links,
    };
  } finally {
    await browser?.close();
  }
}

async function settlePage(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  } catch {
    // Some retail pages keep long-running requests open. The initial goto result is enough for parser experiments.
  }
}

async function readBodyText(page: Page, limit: number): Promise<string> {
  const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");

  return text.slice(0, limit);
}

async function readLinks(page: Page, limit: number): Promise<CatalogPageLink[]> {
  return page
    .locator("a[href]")
    .evaluateAll(
      (nodes, maxCount) =>
        nodes.slice(0, maxCount).map((node) => {
          const link = node as unknown as {
            textContent?: string | null;
            href?: string;
            getAttribute?: (name: string) => string | null;
          };

          return {
            text: (link.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
            href: link.href ?? link.getAttribute?.("href") ?? "",
          };
        }),
      limit,
    )
    .catch(() => []);
}
