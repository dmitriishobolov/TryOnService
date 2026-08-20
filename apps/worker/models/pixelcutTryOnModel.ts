import { sleep } from "../../shared/http.js";
import {
  createStoredResult,
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
} from "./providerUtils.js";
import type { TryOnModelAdapter, TryOnModelInput } from "./types.js";

const provider = "pixelcut";

export const pixelcutTryOnAdapter: TryOnModelAdapter = {
  provider,
  displayName: "Pixelcut",
  run: async ({ job, config, coordinator, signal }) => {
    const apiKey = requireApiKey(
      provider,
      "PIXELCUT_API_KEY",
      config.pixelcut.apiKey,
    );
    const files = selectTryOnInputFiles(job, config);
    const personImageUrl = ensurePublicImageUrl(files.person, "person", provider);
    const garmentImageUrl = ensurePublicImageUrl(files.garment, "garment", provider);
    const response = await fetchJson<unknown>(
      provider,
      joinUrl(config.pixelcut.baseUrl, "/v1/try-on"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: JSON.stringify({
          person_image_url: personImageUrl,
          garment_image_url: garmentImageUrl,
          garment_mode: config.pixelcut.garmentMode,
          preprocess_garment: String(config.pixelcut.preprocessGarment),
          remove_background: String(config.pixelcut.removeBackground),
          wait_for_result: "true",
        }),
      },
      config.tryOnModelHttpTimeoutMs,
      signal,
    );
    const resultUrl =
      findFirstUrl(response) ??
      (await pollPixelcutResult(response, apiKey, config, signal));

    if (!resultUrl) {
      throw new TryOnModelError(
        "pixelcut_result_url_missing",
        "Pixelcut response did not contain a result URL",
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

    return createStoredResult("Pixelcut", resultFile);
  },
};

async function pollPixelcutResult(
  initialResponse: unknown,
  apiKey: string,
  config: TryOnModelInput["config"],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const jobId = findFirstId(initialResponse, ["job_id", "jobId", "id"]);

  if (!jobId) {
    return undefined;
  }

  const path = config.pixelcut.jobStatusPathTemplate.replace(
    "{jobId}",
    encodeURIComponent(jobId),
  );

  for (let attempt = 0; attempt < config.tryOnModelMaxPollAttempts; attempt += 1) {
    await sleep(config.tryOnModelPollIntervalMs);

    const response = await fetchJson<unknown>(
      provider,
      joinUrl(config.pixelcut.baseUrl, path),
      {
        method: "GET",
        headers: {
          "X-API-KEY": apiKey,
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
        "pixelcut_generation_failed",
        "Pixelcut generation finished with failed status",
        false,
      );
    }
  }

  throw new TryOnModelError(
    "pixelcut_generation_timeout",
    "Pixelcut generation did not finish before poll timeout",
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
