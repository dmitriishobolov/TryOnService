import {
  downloadInputImage,
  fetchJson,
  findStringByKeys,
  isRecord,
  joinUrl,
  requireApiKey,
  selectInputFile,
  storeResultFromBuffer,
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
const toolChoiceValues = ["auto", "none", "required"] as const;

export const openAiTryOnAdapter: TryOnModelAdapter = {
  provider,
  displayName: "OpenAI",
  run: async ({ job, config, coordinator, signal }) => {
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
    const inputContentType = resolveOpenAiImageContentType(
      personImage.contentType,
      personRef.key,
      personImage.buffer,
    );
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
    const tools = buildTools(options);
    const include = buildInclude(tools);
    const toolChoice = readToolChoice(options, tools);
    const extraInputImageUrls = readRemoteImageUrls(options);
    logger.info("OpenAI Responses request started", {
      jobId: job.jobId,
      model,
      imageDetail,
      textVerbosity,
      reasoningEffort: reasoning.effort,
      reasoningMode: reasoning.mode,
      maxOutputTokens,
      store,
      inputContentType,
      originalInputContentType: personImage.contentType,
      inputBytes: personImage.buffer.length,
      promptLength: prompt.length,
      tools: tools.map((tool) => tool.type),
      toolChoice,
      extraInputImages: extraInputImageUrls.length,
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
              content: buildUserContent(
                prompt,
                personImage.buffer,
                inputContentType,
                imageDetail,
                extraInputImageUrls,
              ),
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
          ...(tools.length
            ? {
                tools,
                tool_choice: toolChoice,
                ...(include.length ? { include } : {}),
              }
            : {}),
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const outputText = extractOutputText(response);
    const generatedImages = extractGeneratedImages(response);

    if (!outputText && generatedImages.length === 0) {
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
    const files = await Promise.all(
      generatedImages.map((buffer) =>
        storeResultFromBuffer({
          provider,
          jobId: job.jobId,
          buffer,
          contentType: "image/png",
          coordinator,
          config,
          signal,
        }),
      ),
    );

    logger.info("OpenAI Responses request finished", {
      jobId: job.jobId,
      model,
      outputLength: outputText?.length ?? 0,
      generatedImages: files.length,
    });

    return {
      message: `Ответ от сервера. Провайдер: OpenAI.\n\n${
        outputText ?? "Изображение сгенерировано и сохранено в storage."
      }`,
      ...(files.length ? { files } : {}),
    };
  },
};

interface OpenAiToolConfig {
  type: string;
  filters?: {
    allowed_domains?: string[];
  };
  search_context_size?: string;
  model?: string;
  quality?: string;
  size?: string;
  background?: string;
  output_format?: string;
  input_fidelity?: string;
  moderation?: string;
}

type OpenAiInputContent =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
      detail: OpenAiImageDetail;
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

function buildUserContent(
  prompt: string,
  personImageBuffer: Buffer,
  inputContentType: string,
  imageDetail: OpenAiImageDetail,
  extraInputImageUrls: string[],
): OpenAiInputContent[] {
  return [
    {
      type: "input_text",
      text: prompt,
    },
    {
      type: "input_image",
      image_url: toDataUrl(personImageBuffer, inputContentType),
      detail: imageDetail,
    },
    ...extraInputImageUrls.map((imageUrl) => ({
      type: "input_image" as const,
      image_url: imageUrl,
      detail: imageDetail,
    })),
  ];
}

function resolveOpenAiImageContentType(
  contentType: string | undefined,
  key: string,
  buffer: Buffer,
): string {
  if (contentType?.toLowerCase().startsWith("image/")) {
    return contentType;
  }

  const fromKey = imageContentTypeFromKey(key);

  if (fromKey) {
    return fromKey;
  }

  const fromBytes = imageContentTypeFromBytes(buffer);

  if (fromBytes) {
    return fromBytes;
  }

  throw new TryOnModelError(
    "openai_image_content_type_unsupported",
    `OpenAI image input must have an image MIME type; got ${contentType ?? "unknown"}`,
    false,
  );
}

function imageContentTypeFromKey(key: string): string | undefined {
  const extension = key.split(".").pop()?.toLowerCase();

  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }

  if (extension === "png") {
    return "image/png";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  if (extension === "gif") {
    return "image/gif";
  }

  return undefined;
}

function imageContentTypeFromBytes(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }

  return undefined;
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

function buildTools(options: Record<string, unknown>): OpenAiToolConfig[] {
  const webSearchTool = buildWebSearchTool(options);
  const imageGenerationTool = buildImageGenerationTool(options);

  return [webSearchTool, imageGenerationTool].filter(
    (tool): tool is OpenAiToolConfig => Boolean(tool),
  );
}

function buildInclude(tools: OpenAiToolConfig[]): string[] {
  return tools.some((tool) => tool.type === "web_search")
    ? ["web_search_call.results", "web_search_call.action.sources"]
    : [];
}

function readToolChoice(
  options: Record<string, unknown>,
  tools: OpenAiToolConfig[],
): string {
  const value = options.toolChoice;

  if (value === undefined) {
    return tools.length === 1 && tools[0]?.type === "image_generation"
      ? "required"
      : "auto";
  }

  if (
    typeof value === "string" &&
    toolChoiceValues.some((item) => item === value)
  ) {
    return value;
  }

  throw new TryOnModelError(
    "openai_invalid_toolChoice",
    "OpenAI option toolChoice must be auto, none or required",
    false,
  );
}

function buildWebSearchTool(
  options: Record<string, unknown>,
): OpenAiToolConfig | undefined {
  const raw = options.webSearch;

  if (raw === undefined || raw === false) {
    return undefined;
  }

  if (raw !== true && !isRecord(raw)) {
    throw new TryOnModelError(
      "openai_invalid_webSearch",
      "OpenAI option webSearch must be a boolean or object",
      false,
    );
  }

  const rawOptions = isRecord(raw) ? raw : {};
  const allowedDomains = readStringArrayOption(
    rawOptions.allowedDomains ?? options.webSearchAllowedDomains,
    "webSearch.allowedDomains",
  );
  const searchContextSize = readSearchContextSize(
    rawOptions.searchContextSize ?? options.webSearchContextSize,
  );

  return {
    type: "web_search",
    ...(allowedDomains.length
      ? {
          filters: {
            allowed_domains: allowedDomains,
          },
        }
      : {}),
    ...(searchContextSize
      ? {
          search_context_size: searchContextSize,
        }
      : {}),
  };
}

function buildImageGenerationTool(
  options: Record<string, unknown>,
): OpenAiToolConfig | undefined {
  const raw = options.imageGeneration;

  if (raw === undefined || raw === false) {
    return undefined;
  }

  if (raw !== true && !isRecord(raw)) {
    throw new TryOnModelError(
      "openai_invalid_imageGeneration",
      "OpenAI option imageGeneration must be a boolean or object",
      false,
    );
  }

  const rawOptions = isRecord(raw) ? raw : {};

  return {
    type: "image_generation",
    ...readOptionalToolString(rawOptions, "model"),
    ...readOptionalToolString(rawOptions, "quality"),
    ...readOptionalToolString(rawOptions, "size"),
    ...readOptionalToolString(rawOptions, "background"),
    ...readOptionalToolString(rawOptions, "moderation"),
    ...readOptionalToolString(rawOptions, "inputFidelity", "input_fidelity"),
    ...readOptionalToolString(rawOptions, "outputFormat", "output_format"),
  };
}

function readOptionalToolString(
  options: Record<string, unknown>,
  key: string,
  outputKey = key,
): Record<string, string> {
  const value = options[key];

  if (value === undefined) {
    return {};
  }

  if (typeof value === "string" && value.trim()) {
    return {
      [outputKey]: value.trim(),
    };
  }

  throw new TryOnModelError(
    `openai_invalid_imageGeneration_${key}`,
    `OpenAI imageGeneration.${key} must be a string`,
    false,
  );
}

function readStringArrayOption(value: unknown, key: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim())
  ) {
    return value.map((item) => item.trim());
  }

  throw new TryOnModelError(
    `openai_invalid_${key.replace(/[^a-zA-Z0-9]/g, "_")}`,
    `OpenAI option ${key} must be an array of strings`,
    false,
  );
}

function readRemoteImageUrls(options: Record<string, unknown>): string[] {
  const urls = readStringArrayOption(
    options.inputImageUrls ?? options.remoteImageUrls,
    "inputImageUrls",
  );
  const maxUrls = Math.min(
    readNumberOption(options, "maxInputImageUrls", 12),
    80,
  );

  for (const url of urls) {
    if (!isHttpUrl(url)) {
      throw new TryOnModelError(
        "openai_invalid_inputImageUrls",
        "OpenAI option inputImageUrls must contain only http or https URLs",
        false,
      );
    }
  }

  return urls.slice(0, maxUrls);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readSearchContextSize(value: unknown): string | undefined {
  if (value === undefined) {
    return "medium";
  }

  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  throw new TryOnModelError(
    "openai_invalid_webSearchContextSize",
    "OpenAI option webSearchContextSize must be low, medium or high",
    false,
  );
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

function extractGeneratedImages(value: unknown): Buffer[] {
  return collectGeneratedImageBase64(value)
    .map((encoded) => Buffer.from(encoded, "base64"))
    .filter((buffer) => buffer.length > 0);
}

function collectGeneratedImageBase64(value: unknown): string[] {
  if (typeof value === "string") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectGeneratedImageBase64);
  }

  if (!isRecord(value)) {
    return [];
  }

  const result =
    value.type === "image_generation_call" && typeof value.result === "string"
      ? [value.result]
      : [];

  return result.concat(
    Object.values(value).flatMap(collectGeneratedImageBase64),
  );
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
