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
      sourceClientId: request.sourceClientId,
      client: request.client,
      payload: request.payload,
      callbackUrl: request.callbackUrl,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);

    return job;
  }

  createAssigned(
    request: CreateTryOnJobRequest,
    workerId: string,
    dispatchTokenExpiresAt: string,
  ): TryOnJob {
    const now = new Date().toISOString();
    const job: TryOnJob = {
      id: randomUUID(),
      status: "assigned",
      sourceClientId: request.sourceClientId,
      client: request.client,
      payload: request.payload,
      callbackUrl: request.callbackUrl,
      assignedWorkerId: workerId,
      assignedAt: now,
      dispatchTokenExpiresAt,
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

  findExpiredAssignments(timeoutMs: number): TryOnJob[] {
    const now = Date.now();

    return this.list().filter((job) => {
      if (job.status !== "assigned") {
        return false;
      }

      const assignedAt = new Date(job.assignedAt ?? job.updatedAt).getTime();

      return now - assignedAt > timeoutMs;
    });
  }

  findActiveByWorker(workerId: string): TryOnJob[] {
    return this.list().filter(
      (job) =>
        job.assignedWorkerId === workerId &&
        job.status !== "succeeded" &&
        job.status !== "failed" &&
        job.status !== "cancelled",
    );
  }

  findActiveBySourceClient(clientId: string): TryOnJob[] {
    return this.list().filter(
      (job) =>
        job.sourceClientId === clientId &&
        job.status !== "succeeded" &&
        job.status !== "failed" &&
        job.status !== "cancelled",
    );
  }

  markAssigned(jobId: string, workerId: string): TryOnJob | undefined {
    const job = this.jobs.get(jobId);

    if (!job || job.status !== "queued") {
      return undefined;
    }

    return this.update(jobId, {
      status: "assigned",
      assignedWorkerId: workerId,
      assignedAt: new Date().toISOString(),
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

    if (
      job.status === "succeeded" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return job;
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
      assignedAt: undefined,
      dispatchTokenExpiresAt: undefined,
    });
  }

  markAssignmentExpired(jobId: string): TryOnJob | undefined {
    return this.markFailed(jobId, {
      code: "assignment_expired",
      message: "Worker assignment expired before direct client dispatch",
      retryable: true,
    });
  }

  markFailed(jobId: string, error: TryOnJob["error"]): TryOnJob | undefined {
    const job = this.jobs.get(jobId);

    if (
      !job ||
      job.status === "succeeded" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return job;
    }

    return this.update(jobId, {
      status: "failed",
      error,
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
