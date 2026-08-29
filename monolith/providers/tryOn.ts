import { sleep } from "../utils/http.js";
import { createLogger } from ".././utils/logger.js";
import type { MonolithConfig } from "../config.js";
import type { ImageData, TryOnInput, TryOnOutput } from "../types.js";
import {
  fetchWithTimeout,
  findFirstId,
  findFirstUrl,
  joinUrl,
  readResponseBuffer,
  responseError,
} from "../utils/http.js";

const logger = createLogger("monolith");

export interface TryOnProvider {
  readonly name: string;
  run(input: TryOnInput): Promise<TryOnOutput>;
}

export function createTryOnProvider(config: MonolithConfig): TryOnProvider {
  if (config.tryOnProvider === "pruna") {
    return new PrunaTryOnProvider(config);
  }

  return new MockTryOnProvider(config);
}

class MockTryOnProvider implements TryOnProvider {
  readonly name = "mock";

  constructor(private readonly config: MonolithConfig) {}

  async run(input: TryOnInput): Promise<TryOnOutput> {
    await sleep(this.config.mockProcessingDelayMs);

    return {
      provider: this.name,
      message:
        "Mock TryOn: API не вызывался. Возвращаю фото пользователя, чтобы проверить Telegram flow и локальное хранение.",
      image: input.person,
    };
  }
}

class PrunaTryOnProvider implements TryOnProvider {
  readonly name = "pruna";

  constructor(private readonly config: MonolithConfig) {}

  async run(input: TryOnInput): Promise<TryOnOutput> {
    const apiKey = this.config.pruna.apiKey;

    if (!apiKey) {
      throw new Error("PRUNA_API_KEY is required when MONOLITH_TRYON_PROVIDER=pruna");
    }

    if (input.garments.length === 0) {
      throw new Error("TryOn input must contain at least one garment");
    }

    logger.info("Pruna try-on started", {
      model: this.config.pruna.model,
      personBytes: input.person.buffer.length,
      garmentCount: input.garments.length,
      garmentBytes: input.garments.map((garment) => garment.buffer.length),
    });

    const [personUrl, ...garmentUrls] = await Promise.all([
      this.uploadPrunaFile(input.person, apiKey),
      ...input.garments.map((garment) => this.uploadPrunaFile(garment, apiKey)),
    ]);
    const prediction = await this.createPrediction(personUrl, garmentUrls, apiKey);
    const resultUrl =
      findTryOnResultUrl(prediction) ??
      (await this.pollPrediction(prediction, apiKey));

    if (!resultUrl) {
      throw new Error("Pruna response did not contain a result URL");
    }

    const result = await this.downloadResult(resultUrl);

    logger.info("Pruna try-on finished", {
      model: this.config.pruna.model,
      resultContentType: result.contentType,
      resultBytes: result.buffer.length,
    });

    return {
      provider: this.name,
      message: "Ответ от сервера. Провайдер: Pruna.",
      image: result,
      raw: prediction,
    };
  }

  private async uploadPrunaFile(image: ImageData, apiKey: string): Promise<string> {
    const form = new FormData();

    form.append(
      "content",
      new Blob([new Uint8Array(image.buffer)], {
        type: image.contentType,
      }),
      image.filename,
    );

    const response = await fetchWithTimeout(
      joinUrl(this.config.pruna.baseUrl, "/v1/files"),
      {
        method: "POST",
        headers: {
          apikey: apiKey,
        },
        body: form,
      },
      this.config.httpTimeoutMs,
    );

    if (!response.ok) {
      throw await responseError("pruna", response);
    }

    const payload = await response.json();
    const fileUrl = findFirstUrl(payload);

    if (!fileUrl) {
      throw new Error("Pruna file upload response did not contain a file URL");
    }

    return fileUrl;
  }

  private async createPrediction(
    personUrl: string,
    garmentUrls: string[],
    apiKey: string,
  ): Promise<unknown> {
    const input: Record<string, unknown> = {
      person_image: personUrl,
      garment_images: garmentUrls,
      output_format: this.config.pruna.outputFormat,
      preserve_input_size: this.config.pruna.preserveInputSize,
      turbo: this.config.pruna.turbo,
    };

    if (this.config.pruna.outputQuality !== undefined) {
      input.output_quality = this.config.pruna.outputQuality;
    }

    if (this.config.pruna.prompt) {
      input.prompt = this.config.pruna.prompt;
    }

    if (this.config.pruna.seed !== undefined) {
      input.seed = this.config.pruna.seed;
    }

    const response = await fetchWithTimeout(
      joinUrl(this.config.pruna.baseUrl, "/v1/predictions"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: apiKey,
          Model: this.config.pruna.model,
          "Try-Sync": "true",
        },
        body: JSON.stringify({ input }),
      },
      this.config.httpTimeoutMs,
    );

    if (!response.ok) {
      throw await responseError("pruna", response);
    }

    return response.json();
  }

  private async pollPrediction(
    initialResponse: unknown,
    apiKey: string,
  ): Promise<string | undefined> {
    const predictionId = findFirstId(initialResponse, [
      "prediction_id",
      "predictionId",
      "id",
    ]);

    if (!predictionId) {
      return undefined;
    }

    const path = this.config.pruna.predictionPathTemplate.replace(
      "{predictionId}",
      encodeURIComponent(predictionId),
    );

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(2_000);

      const response = await fetchWithTimeout(
        joinUrl(this.config.pruna.baseUrl, path),
        {
          method: "GET",
          headers: {
            apikey: apiKey,
          },
        },
        this.config.httpTimeoutMs,
      );

      if (!response.ok) {
        throw await responseError("pruna", response);
      }

      const payload = await response.json();
      const resultUrl = findTryOnResultUrl(payload);

      if (resultUrl) {
        return resultUrl;
      }

      if (isTerminalFailure(payload)) {
        throw new Error("Pruna prediction finished with failed status");
      }
    }

    throw new Error("Pruna prediction did not finish before poll timeout");
  }

  private async downloadResult(resultUrl: string): Promise<ImageData> {
    const response = await fetchWithTimeout(
      resultUrl,
      { method: "GET" },
      this.config.httpTimeoutMs,
    );

    if (!response.ok) {
      throw await responseError("pruna", response);
    }

    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";

    return {
      buffer: await readResponseBuffer(response, this.config.maxDownloadBytes),
      contentType,
      filename: `pruna-result.${extensionForContentType(contentType)}`,
    };
  }
}

function findTryOnResultUrl(value: unknown): string | undefined {
  const preferred = findFirstUrlByKeys(value, [
    "result_url",
    "resultUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
  ]);

  return preferred ?? findFirstUrl(value);
}

function findFirstUrlByKeys(value: unknown, keys: string[]): string | undefined {
  if (typeof value === "string") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstUrlByKeys(item, keys);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const current = record[key];

    if (typeof current === "string" && /^https?:\/\//i.test(current)) {
      return current;
    }
  }

  for (const current of Object.values(record)) {
    const found = findFirstUrlByKeys(current, keys);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function isTerminalFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const status = String(record.status ?? record.state ?? "").toLowerCase();

  return ["failed", "failure", "error", "cancelled", "canceled"].includes(status);
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  const mapped: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };

  return mapped[normalized ?? ""] ?? "bin";
}
