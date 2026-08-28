import { sleep } from "../../../shared/http.js";
import type { StorageObjectRef } from "../../../shared/contracts/index.js";
import {
  appendImageFile,
  createStoredResult,
  downloadInputImage,
  fetchJson,
  findFirstId,
  findFirstUrl,
  isRecord,
  joinUrl,
  requireApiKey,
  selectInputFile,
  storeResultFromUrl,
  TryOnModelError,
} from "../providerUtils.js";
import type {
  DownloadedImage,
  TryOnModelAdapter,
  TryOnModelInput,
} from "../types.js";

const provider = "pruna";

export const prunaTryOnAdapter: TryOnModelAdapter = {
  provider,
  displayName: "Pruna",
  run: async ({ job, config, coordinator, signal }) => {
    const apiKey = requireApiKey(provider, "PRUNA_API_KEY", config.pruna.apiKey);
    const personRef = selectInputFile(
      job,
      config.tryOnPersonImageIndex,
      "person",
    );
    const garmentRefs = selectPrunaGarmentInputFiles(job, config);
    const [person, ...garments] = await Promise.all([
      downloadInputImage(job, personRef, config, signal),
      ...garmentRefs.map((ref) =>
        downloadInputImage(job, ref, config, signal),
      ),
    ]);
    const [personUrl, ...garmentUrls] = await Promise.all([
      uploadPrunaFile(person, apiKey, config, signal),
      ...garments.map((garment) =>
        uploadPrunaFile(garment, apiKey, config, signal),
      ),
    ]);
    const prediction = await createPrunaPrediction(
      personUrl,
      garmentUrls,
      apiKey,
      config,
      signal,
    );
    const resultUrl =
      findFirstUrl(prediction) ??
      (await pollPrunaPrediction(prediction, apiKey, config, signal));

    if (!resultUrl) {
      throw new TryOnModelError(
        "pruna_result_url_missing",
        "Pruna response did not contain a result URL",
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

    return createStoredResult("Pruna", resultFile);
  },
};

function selectPrunaGarmentInputFiles(
  job: TryOnModelInput["job"],
  config: TryOnModelInput["config"],
): StorageObjectRef[] {
  const files = job.payload.inputFiles ?? [];
  const explicitIndexes = readGarmentFileIndexes(job);
  const indexes = explicitIndexes ?? files
    .map((_, index) => index)
    .filter((index) => index !== config.tryOnPersonImageIndex);

  if (indexes.length === 0) {
    return [selectInputFile(job, config.tryOnGarmentImageIndex, "garment")];
  }

  return uniqueNumbers(indexes).map((index) =>
    selectInputFile(job, index, "garment"),
  );
}

function readGarmentFileIndexes(job: TryOnModelInput["job"]): number[] | undefined {
  const options = isRecord(job.payload.model?.options)
    ? job.payload.model.options
    : {};
  const raw = options.garmentFileIndexes;

  if (raw === undefined) {
    return undefined;
  }

  if (
    Array.isArray(raw) &&
    raw.every((item) => Number.isInteger(item) && Number(item) >= 0)
  ) {
    return raw.map(Number);
  }

  throw new TryOnModelError(
    "pruna_invalid_garment_file_indexes",
    "Pruna option garmentFileIndexes must be an array of non-negative integers",
    false,
  );
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

async function uploadPrunaFile(
  image: DownloadedImage,
  apiKey: string,
  config: TryOnModelInput["config"],
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();

  appendImageFile(form, "content", image);

  const response = await fetchJson<unknown>(
    provider,
    joinUrl(config.pruna.baseUrl, "/v1/files"),
    {
      method: "POST",
      headers: {
        apikey: apiKey,
      },
      body: form,
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );
  const fileUrl = findFirstUrl(response);

  if (!fileUrl) {
    throw new TryOnModelError(
      "pruna_file_url_missing",
      "Pruna file upload response did not contain a file URL",
      true,
    );
  }

  return fileUrl;
}

function createPrunaPrediction(
  personUrl: string,
  garmentUrls: string[],
  apiKey: string,
  config: TryOnModelInput["config"],
  signal?: AbortSignal,
): Promise<unknown> {
  const input: Record<string, unknown> = {
    person_image: personUrl,
    garment_images: garmentUrls,
    output_format: config.pruna.outputFormat,
    preserve_input_size: config.pruna.preserveInputSize,
    turbo: config.pruna.turbo,
  };

  if (config.pruna.outputQuality !== undefined) {
    input.output_quality = config.pruna.outputQuality;
  }

  if (config.pruna.prompt) {
    input.prompt = config.pruna.prompt;
  }

  if (config.pruna.seed !== undefined) {
    input.seed = config.pruna.seed;
  }

  return fetchJson(
    provider,
    joinUrl(config.pruna.baseUrl, "/v1/predictions"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        Model: config.pruna.model,
        "Try-Sync": "true",
      },
      body: JSON.stringify({
        input,
      }),
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );
}

async function pollPrunaPrediction(
  initialResponse: unknown,
  apiKey: string,
  config: TryOnModelInput["config"],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const predictionId = findFirstId(initialResponse, [
    "prediction_id",
    "predictionId",
    "id",
  ]);

  if (!predictionId) {
    return undefined;
  }

  const path = config.pruna.predictionPathTemplate.replace(
    "{predictionId}",
    encodeURIComponent(predictionId),
  );

  for (let attempt = 0; attempt < config.tryOnModelMaxPollAttempts; attempt += 1) {
    await sleep(config.tryOnModelPollIntervalMs);

    const response = await fetchJson<unknown>(
      provider,
      joinUrl(config.pruna.baseUrl, path),
      {
        method: "GET",
        headers: {
          apikey: apiKey,
        },
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
        "pruna_generation_failed",
        "Pruna prediction finished with failed status",
        false,
      );
    }
  }

  throw new TryOnModelError(
    "pruna_generation_timeout",
    "Pruna prediction did not finish before poll timeout",
    true,
  );
}

function isTerminalFailure(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const status = String(value.status ?? value.state ?? "").toLowerCase();

  return ["failed", "failure", "error", "cancelled", "canceled"].includes(status);
}
