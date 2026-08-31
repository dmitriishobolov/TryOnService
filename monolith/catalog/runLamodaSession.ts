import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";

import { chromium, type Page } from "playwright";

import { createLamodaBrowserLaunchOptions } from "./providers/lamoda/browser.js";

import {
  loadMonolithConfig,
  type MonolithConfig,
  type MonolithLamodaBrowserChannel,
} from "../config.js";
import { loadEnvFile } from "../utils/env.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("monolith");
const lamodaHomeUrl = "https://www.lamoda.ru/";
const defaultVerifyUrl = "https://www.lamoda.ru/c/477/clothes-muzhskaya-odezhda";

loadEnvFile();

void main().catch((error) => {
  logger.error("Lamoda session setup crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const config = loadMonolithConfig({ requireTelegramToken: false });
  config.catalog.lamodaBrowserChannel = readLamodaBrowserChannel(
    "MONOLITH_LAMODA_BROWSER_CHANNEL",
    config.catalog.lamodaBrowserChannel,
  );
  config.catalog.lamodaBrowserExecutablePath =
    readCliArg("browser-executable-path") ??
    readOptionalString("MONOLITH_LAMODA_BROWSER_EXECUTABLE_PATH") ??
    config.catalog.lamodaBrowserExecutablePath;
  const userDataDir = resolve(
    readCliArg("user-data-dir") ??
      readString("MONOLITH_LAMODA_USER_DATA_DIR", config.catalog.lamodaUserDataDir),
  );
  const startUrl = readCliArg("url") ?? readString("MONOLITH_LAMODA_SESSION_URL", lamodaHomeUrl);
  const verifyUrl = readCliArg("verify-url") ??
    readString("MONOLITH_LAMODA_SESSION_VERIFY_URL", defaultVerifyUrl);
  const keepOpenMs = readNonNegativeNumber("MONOLITH_LAMODA_SESSION_KEEP_OPEN_MS", 0);
  const browserLaunchOptions = createLamodaBrowserLaunchOptions(config);

  logger.info("Lamoda session setup browser opening", {
    startUrl,
    verifyUrl,
    userDataDir,
    browserChannel: config.catalog.lamodaBrowserChannel,
    browserExecutablePath: browserLaunchOptions.executablePath ?? config.catalog.lamodaBrowserExecutablePath,
  });

  const context = await chromium.launchPersistentContext(userDataDir, {
    ...browserLaunchOptions,
    headless: false,
    userAgent: config.catalog.userAgent,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1366, height: 900 },
    colorScheme: "light",
    extraHTTPHeaders: {
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.6,en;q=0.4",
    },
  });
  const page = context.pages().find((candidate) => !candidate.isClosed()) ??
    await context.newPage();
  const rl = createInterface({ input, output });

  try {
    await page.goto(startUrl, {
      waitUntil: config.catalog.browserWaitUntil,
      timeout: config.catalog.browserTimeoutMs,
    });

    console.log("");
    console.log("Lamoda browser profile is open.");
    console.log("Log in or pass the visible Lamoda check manually in the opened browser.");
    console.log("After the catalog page opens normally, return here and press Enter.");
    console.log("");

    await rl.question("Press Enter to verify and save the Lamoda browser session...");

    const result = await verifyLamodaSession(page, verifyUrl, config);

    if (result.rejected) {
      logger.warn("Lamoda session still looks rejected", result);
      console.log("");
      console.log("Lamoda still returns a rejected page for this profile/IP.");
      console.log("Keep the browser profile and try again later, or complete any visible check before pressing Enter.");
    } else {
      logger.info("Lamoda session verified", result);
      console.log("");
      console.log("Lamoda session looks usable. Cookies were saved to the persistent profile.");
    }

    if (keepOpenMs > 0) {
      await page.waitForTimeout(keepOpenMs);
    }
  } finally {
    rl.close();
    await context.close();
  }
}

async function verifyLamodaSession(
  page: Page,
  verifyUrl: string,
  config: MonolithConfig,
): Promise<{
  verifyUrl: string;
  finalUrl: string;
  status?: number;
  title: string;
  productLinks: number;
  rejected: boolean;
}> {
  const response = await page.goto(verifyUrl, {
    waitUntil: config.catalog.browserWaitUntil,
    timeout: config.catalog.browserTimeoutMs,
  });
  await page.waitForTimeout(2_000);

  const title = await page.title();
  const bodyPreview = await page.locator("body").textContent({ timeout: 5_000 }).catch(() => "");
  const productLinks = await page.locator('a[href*="/p/"]').count().catch(() => 0);
  const status = response?.status();
  const rejected = status === 403 || isRejectedLamodaPage(title, bodyPreview ?? "");

  return {
    verifyUrl,
    finalUrl: page.url(),
    status,
    title,
    productLinks,
    rejected,
  };
}

function isRejectedLamodaPage(title: string, bodyPreview: string): boolean {
  return /\u0417\u0430\u043f\u0440\u043e\u0441\s+\u043e\u0442\u043a\u043b\u043e\u043d\u0435\u043d|forbidden|access denied/i.test(
    [title, bodyPreview].join(" "),
  );
}

function readLamodaBrowserChannel(
  name: string,
  fallback: MonolithLamodaBrowserChannel,
): MonolithLamodaBrowserChannel {
  const cliValue = readCliArg("browser-channel");
  const value = (cliValue || readString(name, fallback)).toLowerCase();

  if (value === "chromium" || value === "chrome" || value === "msedge" || value === "opera") {
    return value;
  }

  throw new Error(name + " or --browser-channel must be chromium, chrome, msedge or opera");
}

function readCliArg(name: string): string | undefined {
  const prefix = "--" + name + "=";

  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() || undefined;
}

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readOptionalString(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(name + " must be a non-negative number");
  }

  return value;
}
