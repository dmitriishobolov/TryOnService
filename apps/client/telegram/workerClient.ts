import type {
  TryOnJobAssignmentResponse,
  WorkerJobAcceptedResponse,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import type { TelegramClientConfig } from "./config.js";

export class TelegramWorkerClient {
  constructor(private readonly config: TelegramClientConfig) {}

  dispatchJob(
    assignment: TryOnJobAssignmentResponse,
  ): Promise<WorkerJobAcceptedResponse> {
    return postJson<WorkerJobAcceptedResponse>(
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
  }
}
