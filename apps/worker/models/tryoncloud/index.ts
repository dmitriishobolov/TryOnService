import {
  appendImageFile,
  createStoredResult,
  downloadInputImage,
  ensurePublicImageUrl,
  fetchJson,
  fetchWithTimeout,
  findFirstUrl,
  joinUrl,
  providerResponseError,
  requireApiKey,
  selectTryOnInputFiles,
  storeResultFromResponse,
  storeResultFromUrl,
  TryOnModelError,
} from "../providerUtils.js";
import type { TryOnModelAdapter, TryOnModelInput } from "../types.js";

const provider = "tryoncloud";

export const tryOnCloudAdapter: TryOnModelAdapter = {
  provider,
  displayName: "TryOnCloud",
  run: (input) =>
    input.config.tryOnCloud.mode === "platform"
      ? runPlatformApi(input)
      : runDeveloperApi(input),
};

async function runDeveloperApi(input: TryOnModelInput) {
  const { job, config, coordinator, signal } = input;
  const apiKey = requireApiKey(
    provider,
    "TRYONCLOUD_API_KEY",
    config.tryOnCloud.apiKey,
  );
  const files = selectTryOnInputFiles(job, config);
  const [person, garment] = await Promise.all([
    downloadInputImage(job, files.person, config, signal),
    downloadInputImage(job, files.garment, config, signal),
  ]);
  const form = new FormData();

  appendImageFile(form, "person_image", person);
  appendImageFile(form, "garment_image", garment);

  const response = await fetchWithTimeout(
    joinUrl(config.tryOnCloud.baseUrl, "/api/v1/generate"),
    {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
      },
      body: form,
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );

  if (!response.ok) {
    throw await providerResponseError(provider, response);
  }

  const resultFile = await storeResultFromResponse({
    provider,
    jobId: job.jobId,
    response,
    coordinator,
    config,
    signal,
  });

  return createStoredResult("TryOnCloud", resultFile);
}

async function runPlatformApi(input: TryOnModelInput) {
  const { job, config, coordinator, signal } = input;
  const apiKey = requireApiKey(
    provider,
    "TRYONCLOUD_API_KEY",
    config.tryOnCloud.apiKey,
  );
  const files = selectTryOnInputFiles(job, config);
  const person = await downloadInputImage(job, files.person, config, signal);
  const garmentUrl = ensurePublicImageUrl(files.garment, "garment", provider);
  const form = new FormData();

  appendImageFile(form, "user_image", person);
  form.append("product_image_url", garmentUrl);

  const response = await fetchJson<unknown>(
    provider,
    joinUrl(config.tryOnCloud.baseUrl, "/api/v1/tryon"),
    {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
      },
      body: form,
    },
    config.tryOnModelHttpTimeoutMs,
    signal,
  );
  const resultUrl = findFirstUrl(response);

  if (!resultUrl) {
    throw new TryOnModelError(
      "tryoncloud_result_url_missing",
      "TryOnCloud platform response did not contain a result URL",
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

  return createStoredResult("TryOnCloud", resultFile);
}
