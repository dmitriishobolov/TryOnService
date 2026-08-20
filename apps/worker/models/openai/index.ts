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
import type { WorkerConfig } from "../../config/index.js";
import type { TryOnModelAdapter } from "../types.js";

const provider = "openai";

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
    const personImage = await downloadInputImage(job, personRef, config, signal);
    const prompt = job.payload.text?.trim() || config.openai.wardrobePrompt;
    const response = await fetchJson<unknown>(
      provider,
      joinUrl(config.openai.baseUrl, "/v1/responses"),
      {
        method: "POST",
        headers: openAiHeaders(apiKey, config),
        body: JSON.stringify({
          model: job.payload.model?.providerModel ?? config.openai.model,
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
                  detail: config.openai.imageDetail,
                },
              ],
            },
          ],
          max_output_tokens: config.openai.maxOutputTokens,
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const outputText = extractOutputText(response);

    if (!outputText) {
      throw new TryOnModelError(
        "openai_output_text_missing",
        "OpenAI response did not contain output text",
        true,
      );
    }

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
