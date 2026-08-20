import { createServer } from "node:http";
import type { Server } from "node:http";

import {
  isWorkerJobRequest,
  type WorkerJobAcceptedResponse,
} from "../../shared/contracts/index.js";
import {
  readJsonBody,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import type { WorkerConfig } from "../config/index.js";
import { runWorkerJob } from "../runner/index.js";
import type { CoordinatorClient } from "./coordinatorClient.js";

interface WorkerServerDeps {
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  getRunningJobs: () => number;
  incrementRunningJobs: () => void;
  decrementRunningJobs: () => void;
}

export function createWorkerServer(deps: WorkerServerDeps): Server {
  const {
    config,
    coordinator,
    getRunningJobs,
    incrementRunningJobs,
    decrementRunningJobs,
  } = deps;

  return createServer(async (request, response) => {
    const url = requestUrl(request);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          workerId: config.workerId,
          runningJobs: getRunningJobs(),
          capacity: config.capacity,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        if (!hasWorkerKey(request.headers["x-worker-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        if (getRunningJobs() >= config.capacity) {
          writeError(response, 429, "worker_busy", "Worker has no free capacity");
          return;
        }

        const body = await readJsonBody(request);

        if (!isWorkerJobRequest(body)) {
          writeError(response, 400, "invalid_worker_job", "Invalid worker job payload");
          return;
        }

        incrementRunningJobs();

        void runWorkerJob(body, config, coordinator)
          .catch((error) => {
            console.error(`[worker] Job ${body.jobId} failed`, error);
          })
          .finally(() => {
            decrementRunningJobs();
            void coordinator.heartbeat(getRunningJobs()).catch((error) => {
              console.error("[worker] Failed to send heartbeat after job", error);
            });
          });

        const payload: WorkerJobAcceptedResponse = {
          jobId: body.jobId,
          accepted: true,
        };

        writeJson(response, 202, payload);
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      console.error("[worker] Unhandled request error", error);
      writeError(response, 500, "internal_error", "Internal server error");
    }
  });
}

function hasWorkerKey(
  headerValue: string | string[] | undefined,
  config: WorkerConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.registrationKey;
}
