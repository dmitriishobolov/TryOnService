export class ExternalApiError extends Error {
  constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
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

export async function readResponseBuffer(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");

  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Response is larger than ${maxBytes} bytes`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > maxBytes) {
    throw new Error(`Response is larger than ${maxBytes} bytes`);
  }

  return buffer;
}

export async function responseError(
  provider: string,
  response: Response,
): Promise<ExternalApiError> {
  const raw = await response.text().catch(() => "");
  const parsed = parseJson(raw);
  const message =
    findNestedStringByKeys(parsed, ["message", "detail", "description"]) ??
    (raw.slice(0, 500) ||
      `${provider} request failed with status ${response.status}`);

  return new ExternalApiError(
    provider,
    response.status,
    `${provider} request failed with status ${response.status}: ${message}`,
  );
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;

  return `${base}${suffix}`;
}

export function findFirstId(value: unknown, keys: string[]): string | undefined {
  return findNestedStringByKeys(value, keys)?.trim() || undefined;
}

export function findFirstUrl(value: unknown): string | undefined {
  const preferred = findNestedStringByKeys(value, [
    "result_url",
    "resultUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
    "image_url",
    "imageUrl",
    "url",
  ]);

  if (preferred && isHttpUrl(preferred)) {
    return preferred;
  }

  return findNestedUrl(value, 0);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(raw: string): unknown {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
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

  for (const key of keys) {
    const current = value[key];

    if (typeof current === "string" && current.trim()) {
      return current;
    }

    if (Array.isArray(current) || isRecord(current)) {
      const nested = findNestedStringByKeys(current, keys);

      if (nested) {
        return nested;
      }
    }
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

function findNestedUrl(value: unknown, depth: number): string | undefined {
  if (depth > 8) {
    return undefined;
  }

  if (typeof value === "string") {
    return isHttpUrl(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedUrl(item, depth + 1);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const current of Object.values(value)) {
    const found = findNestedUrl(current, depth + 1);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
