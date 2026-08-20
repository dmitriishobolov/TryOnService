import { loadEnvFile } from "../shared/env.js";
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
const scheduler = new Scheduler(config, jobs, workers);
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
  }

  void scheduler.schedule();
}, config.workerHeartbeatIntervalMs);

setInterval(() => {
  const staleClients = clients.markStaleClientsOffline(
    config.clientHeartbeatTimeoutMs,
  );

  for (const client of staleClients) {
    console.warn(
      `[coordinator] Client ${client.clientId} marked offline after missed heartbeat`,
    );
  }
}, config.clientHeartbeatIntervalMs);
