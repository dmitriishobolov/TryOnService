import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiErrorResponse } from "./contracts/index.js";

export class HttpRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HttpResponseError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ReadJsonBodyOptions {
  maxBytes?: number;
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export async function readJsonBody<T = unknown>(
  request: IncomingMessage,
  options: ReadJsonBodyOptions = {},
): Promise<T> {
  const maxBytes = options.maxBytes ?? 1_048_576;
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maxBytes) {
      throw new HttpRequestError(
        413,
        "payload_too_large",
        `Request body exceeds ${maxBytes} bytes`,
      );
    }

    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();

  if (!body) {
    return undefined as T;
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpRequestError(400, "invalid_json", "Invalid JSON payload");
  }
}

export function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  const payload: ApiErrorResponse = {
    error: {
      code,
      message,
    },
  };

  writeJson(response, statusCode, payload);
}

export async function postJson<TResponse = unknown>(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  options: Omit<PostJsonOptions, "headers"> = {},
): Promise<TResponse> {
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 250;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postJsonOnce<TResponse>(url, payload, {
        headers,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      lastError = error;

      if (attempt >= retries || !isRetryablePostError(error)) {
        break;
      }

      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("POST request failed");
}

async function postJsonOnce<TResponse>(
  url: string,
  payload: unknown,
  options: Pick<PostJsonOptions, "headers" | "timeoutMs">,
): Promise<TResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 5_000);

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const parsed = parseJsonResponse(text);

  if (!response.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error === "object" &&
      "message" in parsed.error
        ? String(parsed.error.message)
        : `Request failed with status ${response.status}`;

    throw new HttpResponseError(response.status, message);
  }

  return parsed as TResponse;
}

function parseJsonResponse(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRetryablePostError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  if (error instanceof HttpResponseError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }

  return (
    error.name === "AbortError" ||
    error.message.includes("fetch failed") ||
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT")
  );
}

export function writeCaughtError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpRequestError) {
    writeError(response, error.statusCode, error.code, error.message);
    return;
  }

  writeError(response, 500, "internal_error", "Internal server error");
}

export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
