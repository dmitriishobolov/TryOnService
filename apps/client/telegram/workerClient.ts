import type {
  TryOnJobAssignmentResponse,
  WorkerJobAcceptedResponse,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
import type { TelegramClientConfig } from "./config.js";

const logger = createLogger("telegram");

export class TelegramWorkerClient {
  constructor(private readonly config: TelegramClientConfig) {}

  async dispatchJob(
    assignment: TryOnJobAssignmentResponse,
  ): Promise<WorkerJobAcceptedResponse> {
    logger.info("Dispatching job to worker", {
      jobId: assignment.job.id,
      workerId: assignment.worker.workerId,
      jobUrl: assignment.worker.jobUrl,
      provider: assignment.workerRequest.payload.model?.provider ?? "mock",
      task: assignment.workerRequest.payload.model?.task,
      inputFiles: assignment.workerRequest.payload.inputFiles?.length ?? 0,
    });

    try {
      const response = await postJson<WorkerJobAcceptedResponse>(
        assignment.worker.jobUrl,
        assignment.workerRequest,
        {
          "x-job-dispatch-token": assignment.worker.dispatchToken,
        },
        {
          retries: this.config.httpClientRetries,
          timeoutMs: this.config.httpClientTimeoutMs,
        },
      );

      logger.info("Worker accepted dispatched job", {
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
        accepted: response.accepted,
      });

      return response;
    } catch (error) {
      logger.error("Worker dispatch failed", {
        jobId: assignment.job.id,
        workerId: assignment.worker.workerId,
        jobUrl: assignment.worker.jobUrl,
        error,
      });
      throw error;
    }
  }
}
