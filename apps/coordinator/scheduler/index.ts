import type {
  WorkerJobAcceptedResponse,
  WorkerJobRequest,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import type { CoordinatorConfig } from "../config/index.js";
import type { InMemoryJobStore } from "../jobs/store.js";
import type { WorkerRegistry } from "../registry/store.js";

export class Scheduler {
  private isScheduling = false;

  constructor(
    private readonly config: CoordinatorConfig,
    private readonly jobs: InMemoryJobStore,
    private readonly workers: WorkerRegistry,
  ) {}

  async schedule(): Promise<void> {
    if (this.isScheduling) {
      return;
    }

    this.isScheduling = true;

    try {
      for (const job of this.jobs.findQueued()) {
        const worker = this.workers.findAvailable(
          this.config.workerHeartbeatTimeoutMs,
        );

        if (!worker) {
          return;
        }

        const reservedWorker = this.workers.reserve(worker.workerId);

        if (!reservedWorker) {
          continue;
        }

        const assignedJob = this.jobs.markAssigned(job.id, worker.workerId);

        if (!assignedJob) {
          this.workers.release(worker.workerId);
          continue;
        }

        const request: WorkerJobRequest = {
          jobId: assignedJob.id,
          client: assignedJob.client,
          payload: assignedJob.payload,
          callbackUrl: assignedJob.callbackUrl,
          coordinator: {
            progressUrl: `${this.config.publicUrl}/jobs/${assignedJob.id}/progress`,
            resultUrl: `${this.config.publicUrl}/jobs/${assignedJob.id}/result`,
          },
        };

        try {
          await postJson<WorkerJobAcceptedResponse>(
            `${reservedWorker.baseUrl}/jobs`,
            request,
            {
              "x-worker-key": this.config.workerRegistrationKey,
            },
          );
        } catch (error) {
          console.error(
            `[coordinator] Failed to dispatch job ${assignedJob.id} to worker ${worker.workerId}`,
            error,
          );
          this.jobs.requeue(assignedJob.id);
          this.workers.markOffline(worker.workerId);
        }
      }
    } finally {
      this.isScheduling = false;
    }
  }
}
