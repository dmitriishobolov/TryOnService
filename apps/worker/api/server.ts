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
  writeCaughtError,
  readJsonBody,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import { FixedWindowRateLimiter } from "../../shared/rateLimit.js";
import { TokenReplayGuard } from "../../shared/tokenReplayGuard.js";
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
  const rateLimiter = new FixedWindowRateLimiter(
    config.apiRateLimitMaxRequests,
    config.apiRateLimitWindowMs,
  );
  const dispatchReplayGuard = new TokenReplayGuard();
  setInterval(() => {
    rateLimiter.cleanup();
  }, config.apiRateLimitWindowMs).unref();

  return createServer(async (request, response) => {
    const url = requestUrl(request);
    const rateLimit = rateLimiter.consume(resolveDirectRequestAddress(request));

    try {
      if (!rateLimit.allowed) {
        writeError(response, 429, "rate_limited", "Too many requests");
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        if (!hasWorkerServiceKey(request.headers["x-worker-service-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

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
        if (!hasWorkerServiceKey(request.headers["x-worker-service-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        assignments.cleanupExpired();

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

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

      const cancelMatch = /^\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);

      if (request.method === "POST" && cancelMatch) {
        if (!hasWorkerServiceKey(request.headers["x-worker-service-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const cancelled = assignments.cancel(cancelMatch[1]);

        writeJson(response, 200, {
          ok: true,
          jobId: cancelMatch[1],
          cancelledPending: Boolean(cancelled),
          runningCancellationSupported: false,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        assignments.cleanupExpired();

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

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

        const token = validateWorkerJobAccess(request.headers, body.jobId, config);

        if (!token.valid) {
          writeError(response, 401, "unauthorized_worker_job", "Invalid job token");
          return;
        }

        if (dispatchReplayGuard.hasSeen(token.tokenId)) {
          writeError(
            response,
            409,
            "worker_dispatch_token_replayed",
            "Dispatch token has already been used",
          );
          return;
        }

        if (getRunningJobs() >= config.capacity) {
          writeError(response, 429, "worker_busy", "Worker has no free capacity");
          return;
        }

        dispatchReplayGuard.remember(token.tokenId, token.expiresAt);
        assignments.consume(body.jobId);
        incrementRunningJobs();

        void runWorkerJob(body, config, coordinator, assignment.callbackToken)
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
      writeCaughtError(response, error);
    }
  });
}

function hasWorkerServiceKey(
  headerValue: string | string[] | undefined,
  config: WorkerConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.serviceKey;
}

function validateWorkerJobAccess(
  headers: Record<string, string | string[] | undefined>,
  jobId: string,
  config: WorkerConfig,
): { valid: true; tokenId: string; expiresAt: string } | { valid: false } {
  const token = firstHeaderValue(headers["x-job-dispatch-token"]);
  const verification = verifyDispatchToken(token, config.dispatchSigningKey);
  const payload = verification.payload;

  if (
    verification.valid &&
    payload?.purpose === "worker-dispatch" &&
    payload.jobId === jobId &&
    payload.workerId === config.workerId &&
    payload.keyVersion === config.dispatchSigningKeyVersion &&
    payload.tokenId
  ) {
    return {
      valid: true,
      tokenId: payload.tokenId,
      expiresAt: payload.expiresAt,
    };
  }

  return {
    valid: false,
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveDirectRequestAddress(request: {
  socket: { remoteAddress?: string };
}): string {
  return request.socket.remoteAddress ?? "unknown";
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
