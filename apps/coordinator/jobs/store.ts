import { randomUUID } from "node:crypto";

import type {
  CreateTryOnJobRequest,
  JobProgressUpdateRequest,
  JobResultUpdateRequest,
  TryOnJob,
} from "../../shared/contracts/index.js";

export interface JobStore {
  create(request: CreateTryOnJobRequest): Promise<TryOnJob>;
  createAssigned(
    request: CreateTryOnJobRequest,
    workerId: string,
    dispatchTokenExpiresAt: string,
  ): Promise<TryOnJob>;
  get(jobId: string): Promise<TryOnJob | undefined>;
  list(): Promise<TryOnJob[]>;
  findQueued(): Promise<TryOnJob[]>;
  findExpiredAssignments(timeoutMs: number): Promise<TryOnJob[]>;
  findActiveByWorker(workerId: string): Promise<TryOnJob[]>;
  findActiveBySourceClient(clientId: string): Promise<TryOnJob[]>;
  markAssigned(
    jobId: string,
    workerId: string,
    dispatchTokenExpiresAt: string,
  ): Promise<TryOnJob | undefined>;
  markRunning(update: JobProgressUpdateRequest): Promise<TryOnJob | undefined>;
  markResult(update: JobResultUpdateRequest): Promise<TryOnJob | undefined>;
  requeue(jobId: string): Promise<TryOnJob | undefined>;
  markAssignmentExpired(jobId: string): Promise<TryOnJob | undefined>;
  markFailed(
    jobId: string,
    error: TryOnJob["error"],
  ): Promise<TryOnJob | undefined>;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, TryOnJob>();

  async create(request: CreateTryOnJobRequest): Promise<TryOnJob> {
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

  async createAssigned(
    request: CreateTryOnJobRequest,
    workerId: string,
    dispatchTokenExpiresAt: string,
  ): Promise<TryOnJob> {
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

  async get(jobId: string): Promise<TryOnJob | undefined> {
    return this.jobs.get(jobId);
  }

  async list(): Promise<TryOnJob[]> {
    return [...this.jobs.values()];
  }

  async findQueued(): Promise<TryOnJob[]> {
    return (await this.list()).filter((job) => job.status === "queued");
  }

  async findExpiredAssignments(timeoutMs: number): Promise<TryOnJob[]> {
    const now = Date.now();

    return (await this.list()).filter((job) => {
      if (job.status !== "assigned") {
        return false;
      }

      const assignedAt = new Date(job.assignedAt ?? job.updatedAt).getTime();

      return now - assignedAt > timeoutMs;
    });
  }

  async findActiveByWorker(workerId: string): Promise<TryOnJob[]> {
    return (await this.list()).filter(
      (job) =>
        job.assignedWorkerId === workerId &&
        job.status !== "succeeded" &&
        job.status !== "delivery_failed" &&
        job.status !== "failed" &&
        job.status !== "cancelled",
    );
  }

  async findActiveBySourceClient(clientId: string): Promise<TryOnJob[]> {
    return (await this.list()).filter(
      (job) =>
        job.sourceClientId === clientId &&
        job.status !== "succeeded" &&
        job.status !== "delivery_failed" &&
        job.status !== "failed" &&
        job.status !== "cancelled",
    );
  }

  async markAssigned(
    jobId: string,
    workerId: string,
    dispatchTokenExpiresAt: string,
  ): Promise<TryOnJob | undefined> {
    const job = this.jobs.get(jobId);

    if (!job || job.status !== "queued") {
      return undefined;
    }

    return this.update(jobId, {
      status: "assigned",
      assignedWorkerId: workerId,
      assignedAt: new Date().toISOString(),
      dispatchTokenExpiresAt,
    });
  }

  async markRunning(
    update: JobProgressUpdateRequest,
  ): Promise<TryOnJob | undefined> {
    const job = this.jobs.get(update.jobId);

    if (
      !job ||
      job.status === "succeeded" ||
      job.status === "delivery_failed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return undefined;
    }

    return this.update(update.jobId, {
      status: "running",
    });
  }

  async markResult(
    update: JobResultUpdateRequest,
  ): Promise<TryOnJob | undefined> {
    const job = this.jobs.get(update.jobId);

    if (!job) {
      return undefined;
    }

    if (
      job.status === "succeeded" ||
      job.status === "delivery_failed" ||
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

  async requeue(jobId: string): Promise<TryOnJob | undefined> {
    return this.update(jobId, {
      status: "queued",
      assignedWorkerId: undefined,
      assignedAt: undefined,
      dispatchTokenExpiresAt: undefined,
      result: undefined,
      error: undefined,
    });
  }

  async markAssignmentExpired(jobId: string): Promise<TryOnJob | undefined> {
    return this.requeue(jobId);
  }

  async markFailed(
    jobId: string,
    error: TryOnJob["error"],
  ): Promise<TryOnJob | undefined> {
    const job = this.jobs.get(jobId);

    if (
      !job ||
      job.status === "succeeded" ||
      job.status === "delivery_failed" ||
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
