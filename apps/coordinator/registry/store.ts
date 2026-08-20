import type {
  RegisteredWorker,
  WorkerHeartbeatRequest,
  WorkerRegistrationRequest,
} from "../../shared/contracts/index.js";

export interface WorkerRegistryStore {
  register(
    request: WorkerRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredWorker>;
  heartbeat(request: WorkerHeartbeatRequest): Promise<RegisteredWorker | undefined>;
  reserve(workerId: string): Promise<RegisteredWorker | undefined>;
  release(workerId: string): Promise<RegisteredWorker | undefined>;
  markOffline(workerId: string): Promise<RegisteredWorker | undefined>;
  list(): Promise<RegisteredWorker[]>;
  get(workerId: string): Promise<RegisteredWorker | undefined>;
  findAvailable(
    heartbeatTimeoutMs: number,
    requiredCapabilities?: string[],
  ): Promise<RegisteredWorker | undefined>;
  markStaleWorkersOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredWorker[]>;
}

export class WorkerRegistry implements WorkerRegistryStore {
  private readonly workers = new Map<string, RegisteredWorker>();

  async register(
    request: WorkerRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredWorker> {
    const now = new Date().toISOString();
    const previous = this.workers.get(request.workerId);
    const worker: RegisteredWorker = {
      workerId: request.workerId,
      baseUrl: resolvedBaseUrl.replace(/\/$/, ""),
      status: "ready",
      capacity: request.capacity,
      runningJobs: previous?.runningJobs ?? 0,
      capabilities: request.capabilities,
      registeredAt: previous?.registeredAt ?? now,
      lastHeartbeatAt: now,
    };

    this.workers.set(worker.workerId, worker);

    return worker;
  }

  async heartbeat(
    request: WorkerHeartbeatRequest,
  ): Promise<RegisteredWorker | undefined> {
    const worker = this.workers.get(request.workerId);

    if (!worker) {
      return undefined;
    }

    const runningJobs = Math.max(0, request.runningJobs);
    const updated: RegisteredWorker = {
      ...worker,
      status:
        request.status === "offline"
          ? "offline"
          : runningJobs >= request.capacity
            ? "busy"
            : request.status,
      capacity: request.capacity,
      runningJobs,
      lastHeartbeatAt: new Date().toISOString(),
    };

    this.workers.set(updated.workerId, updated);

    return updated;
  }

  async reserve(workerId: string): Promise<RegisteredWorker | undefined> {
    const worker = this.workers.get(workerId);

    if (!worker || worker.runningJobs >= worker.capacity) {
      return undefined;
    }

    const updated: RegisteredWorker = {
      ...worker,
      status: worker.runningJobs + 1 >= worker.capacity ? "busy" : "ready",
      runningJobs: worker.runningJobs + 1,
    };

    this.workers.set(workerId, updated);

    return updated;
  }

  async release(workerId: string): Promise<RegisteredWorker | undefined> {
    const worker = this.workers.get(workerId);

    if (!worker) {
      return undefined;
    }

    const runningJobs = Math.max(0, worker.runningJobs - 1);
    const updated: RegisteredWorker = {
      ...worker,
      status: runningJobs >= worker.capacity ? "busy" : "ready",
      runningJobs,
    };

    this.workers.set(workerId, updated);

    return updated;
  }

  async markOffline(workerId: string): Promise<RegisteredWorker | undefined> {
    const worker = this.workers.get(workerId);

    if (!worker) {
      return undefined;
    }

    const updated: RegisteredWorker = {
      ...worker,
      status: "offline",
      runningJobs: 0,
    };

    this.workers.set(workerId, updated);

    return updated;
  }

  async list(): Promise<RegisteredWorker[]> {
    return [...this.workers.values()];
  }

  async get(workerId: string): Promise<RegisteredWorker | undefined> {
    return this.workers.get(workerId);
  }

  async findAvailable(
    heartbeatTimeoutMs: number,
    requiredCapabilities: string[] = [],
  ): Promise<RegisteredWorker | undefined> {
    const now = Date.now();

    return (await this.list()).find((worker) => {
      const lastHeartbeatAt = new Date(worker.lastHeartbeatAt).getTime();
      const isFresh = now - lastHeartbeatAt <= heartbeatTimeoutMs;
      const hasRequiredCapabilities = requiredCapabilities.every((required) =>
        worker.capabilities.some((capability) => capability.name === required),
      );

      return (
        isFresh &&
        worker.status !== "offline" &&
        worker.runningJobs < worker.capacity &&
        hasRequiredCapabilities
      );
    });
  }

  async markStaleWorkersOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredWorker[]> {
    const now = Date.now();
    const changed: RegisteredWorker[] = [];

    for (const worker of this.workers.values()) {
      const lastHeartbeatAt = new Date(worker.lastHeartbeatAt).getTime();

      if (
        worker.status !== "offline" &&
        now - lastHeartbeatAt > heartbeatTimeoutMs
      ) {
        const offline = await this.markOffline(worker.workerId);

        if (offline) {
          changed.push(offline);
        }
      }
    }

    return changed;
  }
}
