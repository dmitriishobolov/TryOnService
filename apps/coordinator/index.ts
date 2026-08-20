import { createCoordinatorServer } from "./api/server.js";
import { loadCoordinatorConfig } from "./config/index.js";
import { InMemoryJobStore } from "./jobs/store.js";
import { WorkerRegistry } from "./registry/store.js";
import { Scheduler } from "./scheduler/index.js";

const config = loadCoordinatorConfig();
const jobs = new InMemoryJobStore();
const workers = new WorkerRegistry();
const scheduler = new Scheduler(config, jobs, workers);
const server = createCoordinatorServer({
  config,
  jobs,
  workers,
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
