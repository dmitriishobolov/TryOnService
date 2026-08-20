import type {
  TryOnJobAssignmentResponse,
  WorkerJobAcceptedResponse,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";

export class TelegramWorkerClient {
  dispatchJob(
    assignment: TryOnJobAssignmentResponse,
  ): Promise<WorkerJobAcceptedResponse> {
    return postJson<WorkerJobAcceptedResponse>(
      assignment.worker.jobUrl,
      assignment.workerRequest,
      {
        "x-job-dispatch-token": assignment.worker.dispatchToken,
      },
    );
  }
}
