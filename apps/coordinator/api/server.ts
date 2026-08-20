import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";

import {
  isCreateTryOnJobRequest,
  isJobProgressUpdateRequest,
  isJobResultUpdateRequest,
  isWorkerHeartbeatRequest,
  isWorkerRegistrationRequest,
  type WorkerRegistrationRequest,
  type WorkerRegistrationResponse,
} from "../../shared/contracts/index.js";
import {
  readJsonBody,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import type { CoordinatorConfig } from "../config/index.js";
import type { InMemoryJobStore } from "../jobs/store.js";
import type { WorkerRegistry } from "../registry/store.js";
import type { Scheduler } from "../scheduler/index.js";

interface CoordinatorServerDeps {
  config: CoordinatorConfig;
  jobs: InMemoryJobStore;
  workers: WorkerRegistry;
  scheduler: Scheduler;
}

export function createCoordinatorServer(deps: CoordinatorServerDeps): Server {
  const { config, jobs, workers, scheduler } = deps;

  return createServer(async (request, response) => {
    const url = requestUrl(request);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          workers: workers.list(),
          queuedJobs: jobs.findQueued().length,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/jobs") {
        writeJson(response, 200, {
          jobs: jobs.list(),
        });
        return;
      }

      const getJobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname);

      if (request.method === "GET" && getJobMatch) {
        const job = jobs.get(getJobMatch[1]);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        writeJson(response, 200, job);
        return;
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        const body = await readJsonBody(request);

        if (!isCreateTryOnJobRequest(body)) {
          writeError(response, 400, "invalid_job_request", "Invalid job payload");
          return;
        }

        const job = jobs.create(body);
        void scheduler.schedule();

        writeJson(response, 202, job);
        return;
      }

      if (request.method === "POST" && url.pathname === "/workers/register") {
        if (!hasWorkerKey(request.headers["x-worker-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const body = await readJsonBody(request);

        if (!isWorkerRegistrationRequest(body)) {
          writeError(
            response,
            400,
            "invalid_worker_registration",
            "Invalid worker registration payload",
          );
          return;
        }

        const resolvedBaseUrl = resolveWorkerBaseUrl(request, body);
        const worker = workers.register(body, resolvedBaseUrl);
        const payload: WorkerRegistrationResponse = {
          workerId: worker.workerId,
          heartbeatIntervalMs: config.workerHeartbeatIntervalMs,
        };

        void scheduler.schedule();

        writeJson(response, 200, payload);
        return;
      }

      const heartbeatMatch = /^\/workers\/([^/]+)\/heartbeat$/.exec(
        url.pathname,
      );

      if (request.method === "POST" && heartbeatMatch) {
        if (!hasWorkerKey(request.headers["x-worker-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const body = await readJsonBody(request);

        if (!isWorkerHeartbeatRequest(body) || body.workerId !== heartbeatMatch[1]) {
          writeError(
            response,
            400,
            "invalid_worker_heartbeat",
            "Invalid worker heartbeat payload",
          );
          return;
        }

        const worker = workers.heartbeat(body);

        if (!worker) {
          writeError(response, 404, "worker_not_found", "Worker is not registered");
          return;
        }

        void scheduler.schedule();

        writeJson(response, 200, {
          ok: true,
          worker,
        });
        return;
      }

      const progressMatch = /^\/jobs\/([^/]+)\/progress$/.exec(url.pathname);

      if (request.method === "POST" && progressMatch) {
        if (!hasWorkerKey(request.headers["x-worker-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const body = await readJsonBody(request);

        if (!isJobProgressUpdateRequest(body) || body.jobId !== progressMatch[1]) {
          writeError(
            response,
            400,
            "invalid_job_progress",
            "Invalid job progress payload",
          );
          return;
        }

        const job = jobs.markRunning(body);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        writeJson(response, 200, job);
        return;
      }

      const resultMatch = /^\/jobs\/([^/]+)\/result$/.exec(url.pathname);

      if (request.method === "POST" && resultMatch) {
        if (!hasWorkerKey(request.headers["x-worker-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const body = await readJsonBody(request);

        if (!isJobResultUpdateRequest(body) || body.jobId !== resultMatch[1]) {
          writeError(
            response,
            400,
            "invalid_job_result",
            "Invalid job result payload",
          );
          return;
        }

        const previous = jobs.get(body.jobId);
        const job = jobs.markResult(body);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        if (
          previous?.assignedWorkerId &&
          previous.status !== "succeeded" &&
          previous.status !== "failed"
        ) {
          workers.release(previous.assignedWorkerId);
        }

        void scheduler.schedule();

        writeJson(response, 200, job);
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      console.error("[coordinator] Unhandled request error", error);
      writeError(response, 500, "internal_error", "Internal server error");
    }
  });
}

function hasWorkerKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.workerRegistrationKey;
}

function resolveWorkerBaseUrl(
  request: IncomingMessage,
  registration: WorkerRegistrationRequest,
): string {
  if (registration.publicUrl) {
    return registration.publicUrl.replace(/\/$/, "");
  }

  const protocol = registration.publicProtocol ?? "http";
  const host = resolveRequesterHost(request);

  return `${protocol}://${formatHostForUrl(host)}:${registration.port}`;
}

function resolveRequesterHost(request: IncomingMessage): string {
  const forwardedFor = firstHeaderValue(request.headers["x-forwarded-for"]);
  const realIp = firstHeaderValue(request.headers["x-real-ip"]);
  const rawHost =
    forwardedFor?.split(",")[0]?.trim() ||
    realIp ||
    request.socket.remoteAddress;

  if (!rawHost) {
    throw new Error("Cannot resolve worker registration source address");
  }

  return normalizeRemoteAddress(rawHost);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRemoteAddress(address: string): string {
  const trimmed = address.trim();

  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }

  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }

  if (trimmed === "::1") {
    return "localhost";
  }

  const ipv4WithOptionalPort = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(
    trimmed,
  );

  if (ipv4WithOptionalPort) {
    return ipv4WithOptionalPort[1];
  }

  const hostWithPort = /^([^:]+):\d+$/.exec(trimmed);

  if (hostWithPort) {
    return hostWithPort[1];
  }

  return trimmed;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
