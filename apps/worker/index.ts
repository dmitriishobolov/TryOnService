import { loadEnvFile } from "../shared/env.js";
import { CoordinatorClient } from "./api/coordinatorClient.js";
import { createWorkerServer } from "./api/server.js";
import { loadWorkerConfig } from "./config/index.js";

loadEnvFile();

const config = loadWorkerConfig();
const coordinator = new CoordinatorClient(config);
let runningJobs = 0;
let isRegistered = false;

const server = createWorkerServer({
  config,
  coordinator,
  getRunningJobs: () => runningJobs,
  incrementRunningJobs: () => {
    runningJobs += 1;
  },
  decrementRunningJobs: () => {
    runningJobs = Math.max(0, runningJobs - 1);
  },
});

server.listen(config.port, async () => {
  console.log(`[worker] Listening on ${config.baseUrl}`);
  await registerWorker();
});

async function registerWorker(): Promise<void> {
  try {
    const registration = await coordinator.register();
    isRegistered = true;
    console.log(
      `[worker] Registered in coordinator as ${registration.workerId}; heartbeat every ${registration.heartbeatIntervalMs}ms`,
    );
  } catch (error) {
    isRegistered = false;
    console.error("[worker] Failed to register in coordinator", error);
  }
}

setInterval(() => {
  if (!isRegistered) {
    void registerWorker();
    return;
  }

  void coordinator.heartbeat(runningJobs).catch((error) => {
    isRegistered = false;
    console.error("[worker] Failed to send heartbeat", error);
  });
}, config.heartbeatIntervalMs);
