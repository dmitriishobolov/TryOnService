import type {
  RegisteredWorker,
  WorkerHeartbeatRequest,
  WorkerRegistrationRequest,
} from "../../shared/contracts/index.js";

export class WorkerRegistry {
  private readonly workers = new Map<string, RegisteredWorker>();

  register(
    request: WorkerRegistrationRequest,
    resolvedBaseUrl: string,
  ): RegisteredWorker {
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

  heartbeat(request: WorkerHeartbeatRequest): RegisteredWorker | undefined {
    const worker = this.workers.get(request.workerId);

    if (!worker) {
      return undefined;
    }

    const runningJobs = Math.max(worker.runningJobs, request.runningJobs);
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

  reserve(workerId: string): RegisteredWorker | undefined {
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

  release(workerId: string): RegisteredWorker | undefined {
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

  markOffline(workerId: string): RegisteredWorker | undefined {
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

  list(): RegisteredWorker[] {
    return [...this.workers.values()];
  }

  findAvailable(
    heartbeatTimeoutMs: number,
    requiredCapabilities: string[] = [],
  ): RegisteredWorker | undefined {
    const now = Date.now();

    return this.list().find((worker) => {
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

  markStaleWorkersOffline(heartbeatTimeoutMs: number): RegisteredWorker[] {
    const now = Date.now();
    const changed: RegisteredWorker[] = [];

    for (const worker of this.workers.values()) {
      const lastHeartbeatAt = new Date(worker.lastHeartbeatAt).getTime();

      if (
        worker.status !== "offline" &&
        now - lastHeartbeatAt > heartbeatTimeoutMs
      ) {
        const offline = this.markOffline(worker.workerId);

        if (offline) {
          changed.push(offline);
        }
      }
    }

    return changed;
  }
}
