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
): Promise<void> {
  await coordinator.reportProgress({
    jobId: job.jobId,
    status: "running",
    message: "Worker started processing",
  });

  try {
    const result = await runMockTryOnModel(config.mockProcessingDelayMs);

    if (job.callbackUrl) {
      const callback: TelegramJobCallbackRequest = {
        jobId: job.jobId,
        client: job.client,
        result,
      };

      await postJson(
        job.callbackUrl,
        callback,
        callbackToken ? { "x-client-callback-token": callbackToken } : {},
        {
          retries: config.httpClientRetries,
          timeoutMs: config.httpClientTimeoutMs,
        },
      );
    }

    const update: JobResultUpdateRequest = {
      jobId: job.jobId,
      status: "succeeded",
    };

    await coordinator.reportResult(update);
  } catch (error) {
    const update: JobResultUpdateRequest = {
      jobId: job.jobId,
      status: "failed",
      error: {
        code: "worker_processing_failed",
        message: error instanceof Error ? error.message : "Worker processing failed",
        retryable: true,
      },
    };

    await coordinator.reportResult(update);
  }
}
