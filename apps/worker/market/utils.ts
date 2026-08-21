import type {
  MarketProductPrice,
  MarketProductRef,
} from "../../shared/contracts/index.js";

export class MarketplaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function summarizeMarketplaceError(error: unknown): Record<string, unknown> {
  if (error instanceof MarketplaceError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

export function requireMarketCredential(
  provider: string,
  envName: string,
  value: string | undefined,
): string {
  if (!value) {
    throw new MarketplaceError(
      `${provider}_credential_missing`,
      `${envName} is required for ${provider}`,
      false,
    );
  }

  return value;
}

export async function fetchMarketJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchWithTimeout(url, init, timeoutMs, signal);

  if (!response.ok) {
    throw await marketplaceResponseError(provider, response);
  }

  return (await response.json()) as T;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    controller.abort();
  };

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function marketplaceResponseError(
  provider: string,
  response: Response,
): Promise<MarketplaceError> {
  const raw = await response.text().catch(() => "");
  const parsed = parseJson(raw);
  const message =
    findStringByKeys(parsed, ["message", "detail", "error", "errorText"]) ??
    (raw.slice(0, 500) ||
      `${provider} marketplace request failed with status ${response.status}`);

  return new MarketplaceError(
    `${provider}_api_${response.status}`,
    `${provider} marketplace request failed with status ${response.status}: ${message}`,
    response.status === 429 || response.status >= 500,
  );
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;

  return `${base}${suffix}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findStringByKeys(
  value: unknown,
  keys: string[],
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const current = value[key];

    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }

    if (typeof current === "number" && Number.isFinite(current)) {
      return String(current);
    }
  }

  return undefined;
}

export function findNestedStringByKeys(
  value: unknown,
  keys: string[],
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedStringByKeys(item, keys);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const direct = findStringByKeys(value, keys);

  if (direct) {
    return direct;
  }

  for (const current of Object.values(value)) {
    if (Array.isArray(current) || isRecord(current)) {
      const nested = findNestedStringByKeys(current, keys);

      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

export function collectNestedStringsByKeys(
  value: unknown,
  keys: string[],
): string[] {
  const results = new Set<string>();

  collectNestedStrings(value, keys, results);

  return [...results];
}

export function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, "").replace(",", ".");
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function priceFromUnknown(
  amount: unknown,
  currency?: string,
): MarketProductPrice | undefined {
  const parsed = numberFromUnknown(amount);

  if (parsed === undefined) {
    return undefined;
  }

  return {
    amount: parsed,
    ...(currency ? { currency } : {}),
  };
}

export function limitProducts<T>(products: T[], limit: number): T[] {
  return products.slice(0, Math.max(0, limit));
}

export function matchesSearchQuery(product: MarketProductRef, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) {
    return true;
  }

  const haystack = normalizeSearchText(
    [
      product.title,
      product.brand,
      product.category,
      product.productId,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const directTerms = normalizedQuery.split(" ").filter(Boolean);

  if (directTerms.every((term) => haystack.includes(term))) {
    return true;
  }

  return expandMarketQueryTerms(directTerms).some((term) =>
    haystack.includes(term),
  );
}

export function formatProductUrl(
  template: string,
  values: Record<string, string | number | undefined>,
): string | undefined {
  let result = template;

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }

    result = result.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
  }

  return result.includes("{") ? undefined : result;
}

function collectNestedStrings(
  value: unknown,
  keys: string[],
  results: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedStrings(item, keys, results);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of keys) {
    const current = value[key];

    if (typeof current === "string" && current.trim()) {
      results.add(current.trim());
    }

    if (typeof current === "number" && Number.isFinite(current)) {
      results.add(String(current));
    }
  }

  for (const current of Object.values(value)) {
    if (Array.isArray(current) || isRecord(current)) {
      collectNestedStrings(current, keys, results);
    }
  }
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function expandMarketQueryTerms(terms: string[]): string[] {
  const query = terms.join(" ");
  const groups: Array<[RegExp, string[]]> = [
    [/(куртк|жакет|пиджак|блейзер|бомбер|ветровк|верхн)/, [
      "куртк",
      "жакет",
      "пиджак",
      "блейзер",
      "бомбер",
      "ветровк",
    ]],
    [/(брюк|чинос|джинс|штаны|карго)/, [
      "брюк",
      "чинос",
      "джинс",
      "штаны",
      "карго",
    ]],
    [/(рубаш|сорочк|овер?шерт)/, ["рубаш", "сорочк", "овершерт"]],
    [/(футболк|лонгслив|поло)/, ["футболк", "лонгслив", "поло"]],
    [/(джемпер|свитер|кардиган|пуловер)/, [
      "джемпер",
      "свитер",
      "кардиган",
      "пуловер",
    ]],
    [/(худи|толстовк|свитшот)/, ["худи", "толстовк", "свитшот"]],
    [/(обув|кроссов|кеды|ботин|лофер|туфл)/, [
      "обув",
      "кроссов",
      "кеды",
      "ботин",
      "лофер",
      "туфл",
    ]],
  ];

  for (const [pattern, expanded] of groups) {
    if (pattern.test(query)) {
      return expanded;
    }
  }

  return terms;
}

function parseJson(raw: string): unknown {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
