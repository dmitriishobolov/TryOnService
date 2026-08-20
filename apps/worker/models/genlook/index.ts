import { sleep } from "../../../shared/http.js";
import {
  apiKeyHeaders,
  appendImageFile,
  createStoredResult,
  downloadInputImage,
  ensurePublicImageUrl,
  fetchJson,
  findFirstId,
  findFirstUrl,
  isRecord,
  joinUrl,
  requireApiKey,
  selectTryOnInputFiles,
  storeResultFromUrl,
  TryOnModelError,
} from "../providerUtils.js";
import type { TryOnModelAdapter, TryOnModelInput } from "../types.js";

const provider = "genlook";

export const genlookTryOnAdapter: TryOnModelAdapter = {
  provider,
  displayName: "Genlook",
  run: async ({ job, config, coordinator, signal }) => {
    const apiKey = requireApiKey(
      provider,
      "GENLOOK_API_KEY",
      config.genlook.apiKey,
    );
    const headers = authHeaders(apiKey, config);
    const files = selectTryOnInputFiles(job, config);
    const personImageId = await uploadPersonImage(
      files.person,
      headers,
      { job, config, coordinator, signal },
    );
    const garmentImageUrl = ensurePublicImageUrl(
      files.garment,
      "garment",
      provider,
    );
    const generation = await fetchJson<unknown>(
      provider,
      joinUrl(config.genlook.baseUrl, config.genlook.tryOnPath),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          products: [
            {
              imageUrl: garmentImageUrl,
            },
          ],
          person: {
            image: {
              id: personImageId,
            },
          },
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const resultUrl =
      findFirstUrl(generation) ??
      (await pollGenlookGeneration(generation, headers, config, signal));

    if (!resultUrl) {
      throw new TryOnModelError(
        "genlook_result_url_missing",
        "Genlook response did not contain a result URL",
        true,
      );
    }

    const resultFile = await storeResultFromUrl({
      provider,
      jobId: job.jobId,
      resultUrl,
      coordinator,
      config,
      signal,
    });

    return createStoredResult("Genlook", resultFile);
  },
};

async function uploadPersonImage(
  personRef: ReturnType<typeof selectTryOnInputFiles>["person"],
  headers: Record<string, string>,
  input: TryOnModelInput,
): Promise<string> {
  const { job, config, signal } = input;
  let response: unknown;

  if (config.genlook.uploadMode === "url") {
    response = await fetchJson(
      provider,
      joinUrl(config.genlook.baseUrl, config.genlook.uploadPath),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          imageUrl: ensurePublicImageUrl(personRef, "person", provider),
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
  } else {
    const person = await downloadInputImage(job, personRef, config, signal);
    const form = new FormData();

    appendImageFile(form, "image", person);
    response = await fetchJson(
      provider,
      joinUrl(config.genlook.baseUrl, config.genlook.uploadPath),
      {
        method: "POST",
        headers,
        body: form,
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
  }

  const imageId = findFirstId(response, ["imageId", "image_id", "id"]);

  if (!imageId) {
    throw new TryOnModelError(
      "genlook_image_id_missing",
      "Genlook image upload response did not contain imageId",
      true,
    );
  }

  return imageId;
}

async function pollGenlookGeneration(
  initialResponse: unknown,
  headers: Record<string, string>,
  config: TryOnModelInput["config"],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const generationId = findFirstId(initialResponse, [
    "generationId",
    "generation_id",
    "id",
  ]);

  if (!generationId) {
    return undefined;
  }

  const path = config.genlook.generationPathTemplate.replace(
    "{generationId}",
    encodeURIComponent(generationId),
  );

  for (let attempt = 0; attempt < config.tryOnModelMaxPollAttempts; attempt += 1) {
    await sleep(config.tryOnModelPollIntervalMs);

    const response = await fetchJson<unknown>(
      provider,
      joinUrl(config.genlook.baseUrl, path),
      {
        method: "GET",
        headers,
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const resultUrl = findFirstUrl(response);

    if (resultUrl) {
      return resultUrl;
    }

    if (isTerminalFailure(response)) {
      throw new TryOnModelError(
        "genlook_generation_failed",
        "Genlook generation finished with failed status",
        false,
      );
    }
  }

  throw new TryOnModelError(
    "genlook_generation_timeout",
    "Genlook generation did not finish before poll timeout",
    true,
  );
}

function authHeaders(
  apiKey: string,
  config: TryOnModelInput["config"],
): Record<string, string> {
  const prefix =
    config.genlook.apiKeyPrefix?.toLowerCase() === "none"
      ? undefined
      : config.genlook.apiKeyPrefix;

  return apiKeyHeaders(config.genlook.apiKeyHeader, apiKey, prefix);
}

function isTerminalFailure(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const status = String(value.status ?? value.state ?? "").toLowerCase();

  return ["failed", "failure", "error", "cancelled", "canceled"].includes(status);
}
