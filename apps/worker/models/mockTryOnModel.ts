import type { TryOnJobResult } from "../../shared/contracts/index.js";
import { sleep } from "../../shared/http.js";

export async function runMockTryOnModel(
  processingDelayMs: number,
): Promise<TryOnJobResult> {
  await sleep(processingDelayMs);

  return {
    message: "Ответ от сервера.",
  };
}
