import type { CoordinatorConfig } from "../config/index.js";
import type { JobStore } from "../jobs/store.js";
import type { WorkerRegistryStore } from "../registry/store.js";

export class Scheduler {
  private isHousekeeping = false;

  constructor(
    private readonly config: CoordinatorConfig,
    private readonly jobs: JobStore,
    private readonly workers: WorkerRegistryStore,
    private readonly cancelWorkerJob?: (
      workerId: string,
      jobId: string,
    ) => Promise<boolean>,
  ) {}

  async schedule(): Promise<void> {
    if (this.isHousekeeping) {
      return;
    }

    this.isHousekeeping = true;

    try {
      for (const job of await this.jobs.findExpiredAssignments(
        this.config.jobAssignmentTimeoutMs,
      )) {
        let cancelledOnWorker = true;

        if (job.assignedWorkerId) {
          if (this.cancelWorkerJob) {
            try {
              cancelledOnWorker = await this.cancelWorkerJob(
                job.assignedWorkerId,
                job.id,
              );
            } catch (error) {
              cancelledOnWorker = false;
              console.error(
                `[coordinator] Failed to cancel expired assignment ${job.id} on worker ${job.assignedWorkerId}`,
                error,
              );
            }
          }

          if (cancelledOnWorker) {
            await this.workers.release(job.assignedWorkerId);
          }
        }

        if (cancelledOnWorker) {
          await this.jobs.markAssignmentExpired(job.id);
          console.warn(`[coordinator] Assignment for job ${job.id} expired`);
        }
      }
    } finally {
      this.isHousekeeping = false;
    }
  }
}
