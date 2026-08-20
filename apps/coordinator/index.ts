import { loadEnvFile } from "../shared/env.js";
import { postJson } from "../shared/http.js";
import type { RegisteredWorker } from "../shared/contracts/index.js";
import { createCoordinatorServer } from "./api/server.js";
import { loadCoordinatorConfig } from "./config/index.js";
import { InMemoryJobStore } from "./jobs/store.js";
import { ClientRegistry } from "./registry/clientStore.js";
import { WorkerRegistry } from "./registry/store.js";
import { Scheduler } from "./scheduler/index.js";
import { IpBanGuard } from "./utils/ipBanGuard.js";

loadEnvFile();

const config = loadCoordinatorConfig();
const jobs = new InMemoryJobStore();
const workers = new WorkerRegistry();
const clients = new ClientRegistry();
const workerRegistrationGuard = new IpBanGuard(
  config.workerRegistrationMaxInvalidAttempts,
);
const scheduler = new Scheduler(config, jobs, workers, cancelWorkerJobById);
const server = createCoordinatorServer({
  config,
  jobs,
  workers,
  clients,
  workerRegistrationGuard,
  scheduler,
});

server.listen(config.port, () => {
  console.log(`[coordinator] Listening on ${config.publicUrl}`);
});

setInterval(() => {
  const staleWorkers = workers.markStaleWorkersOffline(
    config.workerHeartbeatTimeoutMs,
  );

  for (const worker of staleWorkers) {
    console.warn(
      `[coordinator] Worker ${worker.workerId} marked offline after missed heartbeat`,
    );

    for (const job of jobs.findActiveByWorker(worker.workerId)) {
      jobs.markFailed(job.id, {
        code: "worker_offline",
        message: "Assigned worker went offline during processing",
        retryable: true,
      });
      console.warn(
        `[coordinator] Job ${job.id} failed because worker ${worker.workerId} is offline`,
      );
    }
  }
}, config.workerHeartbeatIntervalMs);

setInterval(() => {
  const staleClients = clients.markStaleClientsOffline(
    config.clientHeartbeatTimeoutMs,
  );

  for (const client of staleClients) {
    console.warn(
      `[coordinator] Client ${client.clientId} marked offline after missed heartbeat`,
    );

    for (const job of jobs.findActiveBySourceClient(client.clientId)) {
      if (job.assignedWorkerId) {
        const worker = workers.get(job.assignedWorkerId);

        if (worker) {
          void cancelWorkerJob(worker, job.id).catch((error) => {
            console.error(
              `[coordinator] Failed to cancel job ${job.id} on worker ${worker.workerId} after client offline`,
              error,
            );
          });
        }

        workers.release(job.assignedWorkerId);
      }

      jobs.markFailed(job.id, {
        code: "client_offline",
        message: "Source client went offline before job completion",
        retryable: true,
      });
      console.warn(
        `[coordinator] Job ${job.id} failed because client ${client.clientId} is offline`,
      );
    }
  }
}, config.clientHeartbeatIntervalMs);

setInterval(() => {
  void scheduler.schedule();
}, config.schedulerIntervalMs);

async function cancelWorkerJobById(
  workerId: string,
  jobId: string,
): Promise<void> {
  const worker = workers.get(workerId);

  if (!worker) {
    return;
  }

  await cancelWorkerJob(worker, jobId);
}

function cancelWorkerJob(worker: RegisteredWorker, jobId: string): Promise<unknown> {
  return postJson(
    `${worker.baseUrl}/jobs/${jobId}/cancel`,
    {},
    {
      "x-worker-service-key": config.workerServiceKey,
    },
    {
      retries: config.httpClientRetries,
      timeoutMs: config.httpClientTimeoutMs,
    },
  );
}
