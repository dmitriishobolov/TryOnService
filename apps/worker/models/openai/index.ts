import {
  downloadInputImage,
  fetchJson,
  findStringByKeys,
  isRecord,
  joinUrl,
  requireApiKey,
  selectInputFile,
  TryOnModelError,
} from "../providerUtils.js";
import { createLogger } from "../../../shared/logger.js";
import type {
  OpenAiImageDetail,
  OpenAiReasoningEffort,
  OpenAiTextVerbosity,
  WorkerConfig,
} from "../../config/index.js";
import type { TryOnModelAdapter } from "../types.js";

const logger = createLogger("worker");
const provider = "openai";
const imageDetailValues = [
  "low",
  "auto",
  "high",
] as const satisfies readonly OpenAiImageDetail[];
const textVerbosityValues = [
  "low",
  "medium",
  "high",
] as const satisfies readonly OpenAiTextVerbosity[];
const reasoningEffortValues = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly OpenAiReasoningEffort[];

export const openAiTryOnAdapter: TryOnModelAdapter = {
  provider,
  displayName: "OpenAI",
  run: async ({ job, config, signal }) => {
    const apiKey = requireApiKey(
      provider,
      "OPENAI_API_KEY",
      config.openai.apiKey,
    );
    const personRef = selectInputFile(
      job,
      config.tryOnPersonImageIndex,
      "person",
    );
    logger.info("OpenAI input image download started", {
      jobId: job.jobId,
      storageId: personRef.storageId,
      key: personRef.key,
      contentType: personRef.contentType,
      sizeBytes: personRef.sizeBytes,
    });
    const personImage = await downloadInputImage(job, personRef, config, signal);
    const prompt = job.payload.text?.trim() || config.openai.wardrobePrompt;
    const options = isRecord(job.payload.model?.options)
      ? job.payload.model.options
      : {};
    const model = job.payload.model?.providerModel ?? config.openai.model;
    const imageDetail = readEnumOption(
      options,
      "imageDetail",
      imageDetailValues,
      config.openai.imageDetail,
    );
    const textVerbosity = readEnumOption(
      options,
      "textVerbosity",
      textVerbosityValues,
      config.openai.textVerbosity,
    );
    const reasoning = buildReasoningConfig(options, config);
    const maxOutputTokens = readNumberOption(
      options,
      "maxOutputTokens",
      config.openai.maxOutputTokens,
    );
    const store = readBooleanOption(
      options,
      "store",
      config.openai.storeResponse,
    );
    logger.info("OpenAI Responses request started", {
      jobId: job.jobId,
      model,
      imageDetail,
      textVerbosity,
      reasoningEffort: reasoning.effort,
      reasoningMode: reasoning.mode,
      maxOutputTokens,
      store,
      inputContentType: personImage.contentType,
      inputBytes: personImage.buffer.length,
      promptLength: prompt.length,
    });
    const response = await fetchJson<unknown>(
      provider,
      joinUrl(config.openai.baseUrl, "/v1/responses"),
      {
        method: "POST",
        headers: openAiHeaders(apiKey, config),
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: config.openai.systemPrompt,
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: prompt,
                },
                {
                  type: "input_image",
                  image_url: toDataUrl(
                    personImage.buffer,
                    personImage.contentType,
                  ),
                  detail: imageDetail,
                },
              ],
            },
          ],
          text: {
            format: {
              type: "text",
            },
            verbosity: textVerbosity,
          },
          reasoning,
          max_output_tokens: maxOutputTokens,
          store,
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const outputText = extractOutputText(response);

    if (!outputText) {
      logger.warn("OpenAI Responses output text missing", {
        jobId: job.jobId,
        model,
      });
      throw new TryOnModelError(
        "openai_output_text_missing",
        "OpenAI response did not contain output text",
        true,
      );
    }

    logger.info("OpenAI Responses request finished", {
      jobId: job.jobId,
      model,
      outputLength: outputText.length,
    });

    return {
      message: `Ответ от сервера. Провайдер: OpenAI.\n\n${outputText}`,
    };
  },
};

function openAiHeaders(
  apiKey: string,
  config: WorkerConfig,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(config.openai.organization
      ? { "OpenAI-Organization": config.openai.organization }
      : {}),
    ...(config.openai.project
      ? { "OpenAI-Project": config.openai.project }
      : {}),
  };
}

function toDataUrl(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function buildReasoningConfig(
  options: Record<string, unknown>,
  config: WorkerConfig,
): Record<string, string> {
  const reasoning: Record<string, string> = {
    effort: readEnumOption(
      options,
      "reasoningEffort",
      reasoningEffortValues,
      config.openai.reasoningEffort,
    ),
  };
  const mode = readStringOption(
    options,
    "reasoningMode",
    config.openai.reasoningMode,
  );

  if (mode) {
    reasoning.mode = mode;
  }

  return reasoning;
}

function readEnumOption<T extends string>(
  options: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = options[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if ((allowed as readonly string[]).includes(normalized)) {
      return normalized as T;
    }
  }

  throw new TryOnModelError(
    `openai_invalid_${key}`,
    `OpenAI option ${key} must be one of: ${allowed.join(", ")}`,
    false,
  );
}

function readStringOption(
  options: Record<string, unknown>,
  key: string,
  fallback: string | undefined,
): string | undefined {
  const value = options[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    return value.trim() || fallback;
  }

  throw new TryOnModelError(
    `openai_invalid_${key}`,
    `OpenAI option ${key} must be a string`,
    false,
  );
}

function readNumberOption(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = options[key];

  if (value === undefined) {
    return fallback;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new TryOnModelError(
    `openai_invalid_${key}`,
    `OpenAI option ${key} must be a positive number`,
    false,
  );
}

function readBooleanOption(
  options: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = options[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }

    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }

  throw new TryOnModelError(
    `openai_invalid_${key}`,
    `OpenAI option ${key} must be a boolean`,
    false,
  );
}

function extractOutputText(value: unknown): string | undefined {
  const outputText = findStringByKeys(value, ["output_text"]);

  if (outputText) {
    return outputText;
  }

  return collectText(value).join("\n").trim() || undefined;
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectText);
  }

  if (!isRecord(value)) {
    return [];
  }

  if (
    (value.type === "output_text" || value.type === "text") &&
    typeof value.text === "string"
  ) {
    return [value.text];
  }

  return Object.values(value).flatMap(collectText);
}
