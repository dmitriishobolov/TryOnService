import type { CoordinatorConfig } from "../config/index.js";
import type { InMemoryJobStore } from "../jobs/store.js";
import type { WorkerRegistry } from "../registry/store.js";

export class Scheduler {
  private isHousekeeping = false;

  constructor(
    private readonly config: CoordinatorConfig,
    private readonly jobs: InMemoryJobStore,
    private readonly workers: WorkerRegistry,
  ) {}

  async schedule(): Promise<void> {
    if (this.isHousekeeping) {
      return;
    }

    this.isHousekeeping = true;

    try {
      for (const job of this.jobs.findExpiredAssignments(
        this.config.jobAssignmentTimeoutMs,
      )) {
        if (job.assignedWorkerId) {
          this.workers.release(job.assignedWorkerId);
        }

        this.jobs.markAssignmentExpired(job.id);
        console.warn(`[coordinator] Assignment for job ${job.id} expired`);
      }
    } finally {
      this.isHousekeeping = false;
    }
  }
}
