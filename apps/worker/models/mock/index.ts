import type { TryOnJobResult } from "../../../shared/contracts/index.js";
import { sleep } from "../../../shared/http.js";

export async function runMockTryOnModel(
  processingDelayMs: number,
  signal?: AbortSignal,
): Promise<TryOnJobResult> {
  await abortableSleep(processingDelayMs, signal);

  return {
    message: "Ответ от сервера.",
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error("Worker job was cancelled");
  error.name = "AbortError";

  return error;
}
