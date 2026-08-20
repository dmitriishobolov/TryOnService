import { sleep } from "../../../shared/http.js";
import {
  createStoredResult,
  downloadInputImage,
  ensurePublicImageUrl,
  fetchJson,
  findFirstId,
  findFirstUrl,
  findStringByKeys,
  isRecord,
  joinUrl,
  requireApiKey,
  selectTryOnInputFiles,
  storeResultFromUrl,
  TryOnModelError,
} from "../providerUtils.js";
import type { TryOnModelAdapter, TryOnModelInput } from "../types.js";
import type { StorageObjectRef } from "../../../shared/contracts/index.js";

const provider = "wearfits";

export const wearfitsTryOnAdapter: TryOnModelAdapter = {
  provider,
  displayName: "WEARFITS",
  run: async ({ job, config, coordinator, signal }) => {
    const apiKey = requireApiKey(
      provider,
      "WEARFITS_API_KEY",
      config.wearfits.apiKey,
    );
    const files = selectTryOnInputFiles(job, config);
    const [personImage, garmentImage] = await Promise.all([
      toWearfitsImageValue(files.person, "person", {
        job,
        config,
        coordinator,
        signal,
      }),
      toWearfitsImageValue(files.garment, "garment", {
        job,
        config,
        coordinator,
        signal,
      }),
    ]);
    const initialResponse = await fetchJson<unknown>(
      provider,
      joinUrl(config.wearfits.baseUrl, "/api/v1/virtual-fitting"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          personImages: [personImage],
          productImage: garmentImage,
          productCategory: config.wearfits.productCategory,
          options: {
            quality: config.wearfits.quality,
            preserveBackground: config.wearfits.preserveBackground,
          },
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const resultUrl =
      resultUrlIfCompleted(initialResponse) ??
      (await pollWearfitsJob(initialResponse, apiKey, config, signal));

    if (!resultUrl) {
      throw new TryOnModelError(
        "wearfits_result_url_missing",
        "WEARFITS response did not contain a result URL",
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

    return createStoredResult("WEARFITS", resultFile);
  },
};

async function toWearfitsImageValue(
  ref: StorageObjectRef,
  role: "person" | "garment",
  input: TryOnModelInput,
): Promise<string> {
  if (input.config.wearfits.imageInputMode === "url") {
    return ensurePublicImageUrl(ref, role, provider);
  }

  const image = await downloadInputImage(
    input.job,
    ref,
    input.config,
    input.signal,
  );

  return `data:${image.contentType};base64,${image.buffer.toString("base64")}`;
}

async function pollWearfitsJob(
  initialResponse: unknown,
  apiKey: string,
  config: TryOnModelInput["config"],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const statusUrl = findStringByKeysIfUrl(initialResponse, [
    "statusUrl",
    "status_url",
  ]);
  const jobId = findFirstId(initialResponse, ["jobId", "job_id", "id"]);
  const url =
    statusUrl ??
    (jobId
      ? joinUrl(config.wearfits.baseUrl, `/api/v1/jobs/${encodeURIComponent(jobId)}`)
      : undefined);

  if (!url) {
    return undefined;
  }

  for (let attempt = 0; attempt < config.tryOnModelMaxPollAttempts; attempt += 1) {
    await sleep(config.tryOnModelPollIntervalMs);

    const response = await fetchJson<unknown>(
      provider,
      url,
      {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
        },
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const resultUrl = resultUrlIfCompleted(response);

    if (resultUrl) {
      return resultUrl;
    }

    if (isTerminalFailure(response)) {
      throw new TryOnModelError(
        "wearfits_generation_failed",
        "WEARFITS job finished with failed status",
        false,
      );
    }
  }

  throw new TryOnModelError(
    "wearfits_generation_timeout",
    "WEARFITS job did not finish before poll timeout",
    true,
  );
}

function resultUrlIfCompleted(value: unknown): string | undefined {
  const status = isRecord(value)
    ? String(value.status ?? value.state ?? "").toLowerCase()
    : "";

  if (status && !["completed", "succeeded", "success", "done"].includes(status)) {
    return undefined;
  }

  return findFirstUrl(value);
}

function findStringByKeysIfUrl(
  value: unknown,
  keys: string[],
): string | undefined {
  const found = findStringByKeys(value, keys);

  return found && /^https?:\/\//i.test(found) ? found : undefined;
}

function isTerminalFailure(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const status = String(value.status ?? value.state ?? "").toLowerCase();

  return ["failed", "failure", "error", "cancelled", "canceled"].includes(status);
}
