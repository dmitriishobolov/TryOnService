import type {
  JobResultUpdateRequest,
  TelegramJobCallbackRequest,
  WorkerJobRequest,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import type { CoordinatorClient } from "../api/coordinatorClient.js";
import type { WorkerConfig } from "../config/index.js";
import { runMockTryOnModel } from "../models/mockTryOnModel.js";

export async function runWorkerJob(
  job: WorkerJobRequest,
  config: WorkerConfig,
  coordinator: CoordinatorClient,
  callbackToken?: string,
  signal?: AbortSignal,
): Promise<void> {
  await coordinator.reportProgress({
    jobId: job.jobId,
    status: "running",
    message: "Worker started processing",
  });

  try {
    const result = await runMockTryOnModel(config.mockProcessingDelayMs, signal);
    let deliveryError: unknown;

    if (job.callbackUrl) {
      const callback: TelegramJobCallbackRequest = {
        jobId: job.jobId,
        client: job.client,
        result,
      };

      try {
        await postJson(
          job.callbackUrl,
          callback,
          callbackToken ? { "x-client-callback-token": callbackToken } : {},
          {
            retries: config.httpClientRetries,
            timeoutMs: config.httpClientTimeoutMs,
          },
        );
      } catch (error) {
        deliveryError = error;
      }
    }

    const update: JobResultUpdateRequest = deliveryError
      ? {
          jobId: job.jobId,
          status: "delivery_failed",
          result,
          error: {
            code: "client_callback_failed",
            message:
              deliveryError instanceof Error
                ? deliveryError.message
                : "Client callback delivery failed",
            retryable: true,
          },
        }
      : {
          jobId: job.jobId,
          status: "succeeded",
          result,
        };

    await coordinator.reportResult(update);
  } catch (error) {
    const wasCancelled =
      error instanceof Error &&
      (error.name === "AbortError" || signal?.aborted === true);
    const update: JobResultUpdateRequest = {
      jobId: job.jobId,
      status: wasCancelled ? "cancelled" : "failed",
      error: {
        code: wasCancelled ? "worker_job_cancelled" : "worker_processing_failed",
        message: error instanceof Error ? error.message : "Worker processing failed",
        retryable: !wasCancelled,
      },
    };

    await coordinator.reportResult(update);
  }
}
