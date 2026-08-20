import { randomUUID } from "node:crypto";

import type {
  CreateTryOnJobRequest,
  JobProgressUpdateRequest,
  JobResultUpdateRequest,
  TryOnJob,
} from "../../shared/contracts/index.js";

export class InMemoryJobStore {
  private readonly jobs = new Map<string, TryOnJob>();

  create(request: CreateTryOnJobRequest): TryOnJob {
    const now = new Date().toISOString();
    const job: TryOnJob = {
      id: randomUUID(),
      status: "queued",
      client: request.client,
      payload: request.payload,
      callbackUrl: request.callbackUrl,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);

    return job;
  }

  get(jobId: string): TryOnJob | undefined {
    return this.jobs.get(jobId);
  }

  list(): TryOnJob[] {
    return [...this.jobs.values()];
  }

  findQueued(): TryOnJob[] {
    return this.list().filter((job) => job.status === "queued");
  }

  markAssigned(jobId: string, workerId: string): TryOnJob | undefined {
    const job = this.jobs.get(jobId);

    if (!job || job.status !== "queued") {
      return undefined;
    }

    return this.update(jobId, {
      status: "assigned",
      assignedWorkerId: workerId,
    });
  }

  markRunning(update: JobProgressUpdateRequest): TryOnJob | undefined {
    const job = this.jobs.get(update.jobId);

    if (!job || job.status === "succeeded" || job.status === "failed") {
      return undefined;
    }

    return this.update(update.jobId, {
      status: "running",
    });
  }

  markResult(update: JobResultUpdateRequest): TryOnJob | undefined {
    const job = this.jobs.get(update.jobId);

    if (!job) {
      return undefined;
    }

    return this.update(update.jobId, {
      status: update.status,
      result: update.result,
      error: update.error,
    });
  }

  requeue(jobId: string): TryOnJob | undefined {
    return this.update(jobId, {
      status: "queued",
      assignedWorkerId: undefined,
    });
  }

  private update(
    jobId: string,
    patch: Partial<Omit<TryOnJob, "id" | "createdAt">>,
  ): TryOnJob | undefined {
    const current = this.jobs.get(jobId);

    if (!current) {
      return undefined;
    }

    const next: TryOnJob = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, next);

    return next;
  }
}
