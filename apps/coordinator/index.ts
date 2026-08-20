import { loadEnvFile } from "../shared/env.js";
import { postJson } from "../shared/http.js";
import type { RegisteredWorker } from "../shared/contracts/index.js";
import { createCoordinatorServer } from "./api/server.js";
import { loadCoordinatorConfig } from "./config/index.js";
import { createCoordinatorStores } from "./persistence/index.js";
import { Scheduler } from "./scheduler/index.js";
import { IpBanGuard } from "./utils/ipBanGuard.js";

loadEnvFile();

const config = loadCoordinatorConfig();
const { jobs, workers, clients, storageNodes, audit, registrationBans, close } =
  await createCoordinatorStores(config);
const workerRegistrationGuard = new IpBanGuard(
  config.workerRegistrationMaxInvalidAttempts,
  (await registrationBans.list("worker")).map((record) => record.ipAddress),
);
const storageRegistrationGuard = new IpBanGuard(
  config.storageRegistrationMaxInvalidAttempts,
  (await registrationBans.list("storage")).map((record) => record.ipAddress),
);
const clientRegistrationGuard = new IpBanGuard(
  config.clientRegistrationMaxInvalidAttempts,
  (await registrationBans.list("client")).map((record) => record.ipAddress),
);
const scheduler = new Scheduler(config, jobs, workers, cancelWorkerJobById);
const server = createCoordinatorServer({
  config,
  jobs,
  workers,
  clients,
  storageNodes,
  audit,
  registrationBans,
  workerRegistrationGuard,
  storageRegistrationGuard,
  clientRegistrationGuard,
  scheduler,
});

server.listen(config.port, () => {
  console.log(`[coordinator] Listening on ${config.publicUrl}`);
  console.log(`[coordinator] Persistence: ${config.persistenceDriver}`);
});

setInterval(() => {
  void markStaleWorkersOffline();
}, config.workerHeartbeatIntervalMs);

setInterval(() => {
  void markStaleClientsOffline();
}, config.clientHeartbeatIntervalMs);

setInterval(() => {
  void markStaleStorageOffline();
}, config.storageHeartbeatIntervalMs);

setInterval(() => {
  void scheduler.schedule();
}, config.schedulerIntervalMs);

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

async function markStaleWorkersOffline(): Promise<void> {
  const staleWorkers = await workers.markStaleWorkersOffline(
    config.workerHeartbeatTimeoutMs,
  );

  for (const worker of staleWorkers) {
    console.warn(
      `[coordinator] Worker ${worker.workerId} marked offline after missed heartbeat`,
    );

    for (const job of await jobs.findActiveByWorker(worker.workerId)) {
      await jobs.markFailed(job.id, {
        code: "worker_offline",
        message: "Assigned worker went offline during processing",
        retryable: true,
      });
      console.warn(
        `[coordinator] Job ${job.id} failed because worker ${worker.workerId} is offline`,
      );
    }
  }
}

async function markStaleClientsOffline(): Promise<void> {
  const staleClients = await clients.markStaleClientsOffline(
    config.clientHeartbeatTimeoutMs,
  );

  for (const client of staleClients) {
    console.warn(
      `[coordinator] Client ${client.clientId} marked offline after missed heartbeat`,
    );

    for (const job of await jobs.findActiveBySourceClient(client.clientId)) {
      if (job.assignedWorkerId) {
        const worker = await workers.get(job.assignedWorkerId);

        if (worker) {
          void cancelWorkerJob(worker, job.id).catch((error) => {
            console.error(
              `[coordinator] Failed to cancel job ${job.id} on worker ${worker.workerId} after client offline`,
              error,
            );
          });
        }

        await workers.release(job.assignedWorkerId);
      }

      await jobs.markFailed(job.id, {
        code: "client_offline",
        message: "Source client went offline before job completion",
        retryable: true,
      });
      console.warn(
        `[coordinator] Job ${job.id} failed because client ${client.clientId} is offline`,
      );
    }
  }
}

async function markStaleStorageOffline(): Promise<void> {
  const staleStorageNodes = await storageNodes.markStaleStorageOffline(
    config.storageHeartbeatTimeoutMs,
  );

  for (const node of staleStorageNodes) {
    console.warn(
      `[coordinator] Storage ${node.storageId} marked offline after missed heartbeat`,
    );
  }
}

async function cancelWorkerJobById(
  workerId: string,
  jobId: string,
): Promise<void> {
  const worker = await workers.get(workerId);

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
      "x-worker-service-key":
        config.workerKeys[worker.workerId] ?? config.workerServiceKey,
    },
    {
      retries: config.httpClientRetries,
      timeoutMs: config.httpClientTimeoutMs,
    },
  );
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[coordinator] Shutting down after ${signal}`);

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await close();
}
