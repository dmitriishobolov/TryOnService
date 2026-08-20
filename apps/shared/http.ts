import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiErrorResponse } from "./contracts/index.js";

export async function readJsonBody<T = unknown>(
  request: IncomingMessage,
): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();

  if (!body) {
    return undefined as T;
  }

  return JSON.parse(body) as T;
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
): Promise<TResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;

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

    throw new Error(message);
  }

  return parsed as TResponse;
}

export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
