import type { Server } from "node:http";

import { loadEnvFile } from "../shared/env.js";
import { findAvailablePort } from "../shared/net.js";
import { CoordinatorClient } from "./api/coordinatorClient.js";
import { createWorkerServer } from "./api/server.js";
import { loadWorkerConfig } from "./config/index.js";

loadEnvFile();

const config = loadWorkerConfig();
const selectedPort = await findAvailablePort(config.port);

if (selectedPort !== config.port) {
  console.warn(
    `[worker] Port ${config.port} is busy, using free port ${selectedPort}`,
  );
  config.port = selectedPort;
  config.localUrl = `http://localhost:${selectedPort}`;
}

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

await listen(server, config.port);

console.log(`[worker] Listening on ${config.localUrl}`);

if (config.publicUrl) {
  console.log(`[worker] Public URL override: ${config.publicUrl}`);
} else {
  console.log("[worker] Public URL will be inferred by coordinator");
}

await registerWorker();

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

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      resolve();
    });
  });
}
