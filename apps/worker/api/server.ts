import { createServer } from "node:http";
import type { Server } from "node:http";

import {
  isWorkerAssignmentPrepareRequest,
  isWorkerJobRequest,
  type WorkerAssignmentPrepareResponse,
  type WorkerJobAcceptedResponse,
} from "../../shared/contracts/index.js";
import { verifyDispatchToken } from "../../shared/dispatchToken.js";
import {
  readJsonBody,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import type { WorkerConfig } from "../config/index.js";
import { runWorkerJob } from "../runner/index.js";
import type { WorkerAssignmentStore } from "./assignmentStore.js";
import type { CoordinatorClient } from "./coordinatorClient.js";

interface WorkerServerDeps {
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  assignments: WorkerAssignmentStore;
  getRunningJobs: () => number;
  getCurrentLoad: () => number;
  incrementRunningJobs: () => void;
  decrementRunningJobs: () => void;
}

export function createWorkerServer(deps: WorkerServerDeps): Server {
  const {
    config,
    coordinator,
    assignments,
    getRunningJobs,
    getCurrentLoad,
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
          pendingAssignments: assignments.countPending(),
          capacity: config.capacity,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/assignments") {
        if (!hasWorkerKey(request.headers["x-worker-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        assignments.cleanupExpired();

        const body = await readJsonBody(request);

        if (!isWorkerAssignmentPrepareRequest(body)) {
          writeError(
            response,
            400,
            "invalid_worker_assignment",
            "Invalid worker assignment payload",
          );
          return;
        }

        if (body.workerId !== config.workerId) {
          writeError(
            response,
            409,
            "wrong_worker_assignment",
            "Assignment is intended for another worker",
          );
          return;
        }

        if (!hasRequiredCapabilities(body.requiredCapabilities, config)) {
          writeError(
            response,
            409,
            "unsupported_worker_capability",
            "Worker does not support required capabilities",
          );
          return;
        }

        if (getCurrentLoad() >= config.capacity) {
          writeError(response, 429, "worker_busy", "Worker has no free capacity");
          return;
        }

        const assignment = assignments.prepare(body);
        const payload: WorkerAssignmentPrepareResponse = {
          jobId: assignment.jobId,
          accepted: true,
          expiresAt: assignment.dispatchTokenExpiresAt,
        };

        writeJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        assignments.cleanupExpired();

        const body = await readJsonBody(request);

        if (!isWorkerJobRequest(body)) {
          writeError(response, 400, "invalid_worker_job", "Invalid worker job payload");
          return;
        }

        const assignment = assignments.get(body.jobId);

        if (!assignment) {
          writeError(
            response,
            409,
            "assignment_not_prepared",
            "Worker has no prepared assignment for this job",
          );
          return;
        }

        if (new Date(assignment.dispatchTokenExpiresAt).getTime() <= Date.now()) {
          assignments.cancel(body.jobId);
          writeError(
            response,
            410,
            "assignment_expired",
            "Prepared assignment has expired",
          );
          return;
        }

        if (!matchesPreparedAssignment(assignment, body)) {
          writeError(
            response,
            409,
            "assignment_mismatch",
            "Job request does not match prepared assignment",
          );
          return;
        }

        if (!hasWorkerJobAccess(request.headers, body.jobId, config)) {
          writeError(response, 401, "unauthorized_worker_job", "Invalid job token");
          return;
        }

        if (getRunningJobs() >= config.capacity) {
          writeError(response, 429, "worker_busy", "Worker has no free capacity");
          return;
        }

        assignments.consume(body.jobId);
        incrementRunningJobs();

        void runWorkerJob(body, config, coordinator)
          .catch((error) => {
            console.error(`[worker] Job ${body.jobId} failed`, error);
          })
          .finally(() => {
            decrementRunningJobs();
            void coordinator.heartbeat(getCurrentLoad()).catch((error) => {
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

function hasWorkerJobAccess(
  headers: Record<string, string | string[] | undefined>,
  jobId: string,
  config: WorkerConfig,
): boolean {
  if (hasWorkerKey(headers["x-worker-key"], config)) {
    return true;
  }

  const token = firstHeaderValue(headers["x-job-dispatch-token"]);
  const verification = verifyDispatchToken(token, config.registrationKey);

  return (
    verification.valid &&
    verification.payload?.jobId === jobId &&
    verification.payload.workerId === config.workerId
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasRequiredCapabilities(
  requiredCapabilities: string[],
  config: WorkerConfig,
): boolean {
  return requiredCapabilities.every((required) =>
    config.capabilities.some((capability) => capability.name === required),
  );
}

function matchesPreparedAssignment(
  assignment: {
    clientChatId: string;
    callbackUrl?: string;
  },
  job: {
    client: {
      chatId: string;
    };
    callbackUrl?: string;
  },
): boolean {
  return (
    assignment.clientChatId === job.client.chatId &&
    assignment.callbackUrl === job.callbackUrl
  );
}
