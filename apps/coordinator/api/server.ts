import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";

import {
  isClientHeartbeatRequest,
  isClientRegistrationRequest,
  isCreateTryOnJobRequest,
  isJobProgressUpdateRequest,
  isJobResultUpdateRequest,
  isWorkerHeartbeatRequest,
  isWorkerRegistrationRequest,
  type ClientRegistrationRequest,
  type ClientRegistrationResponse,
  type CreateTryOnJobRequest,
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
import type { ClientRegistry } from "../registry/clientStore.js";
import type { WorkerRegistry } from "../registry/store.js";
import type { Scheduler } from "../scheduler/index.js";
import type { IpBanGuard } from "../utils/ipBanGuard.js";
import {
  resolveDirectRequestAddress,
  resolveRequesterHost,
} from "../utils/requestAddress.js";

interface CoordinatorServerDeps {
  config: CoordinatorConfig;
  jobs: InMemoryJobStore;
  workers: WorkerRegistry;
  clients: ClientRegistry;
  workerRegistrationGuard: IpBanGuard;
  scheduler: Scheduler;
}

export function createCoordinatorServer(deps: CoordinatorServerDeps): Server {
  const { config, jobs, workers, clients, workerRegistrationGuard, scheduler } =
    deps;

  return createServer(async (request, response) => {
    const url = requestUrl(request);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          workers: workers.list(),
          clients: clients.list(),
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

        const requestWithCallback = resolveJobCallback(body, clients);

        if (!requestWithCallback) {
          writeError(
            response,
            409,
            "client_not_registered",
            "Source client is not registered",
          );
          return;
        }

        const job = jobs.create(requestWithCallback);
        void scheduler.schedule();

        writeJson(response, 202, job);
        return;
      }

      if (request.method === "POST" && url.pathname === "/clients/register") {
        if (!hasClientKey(request.headers["x-client-key"], config)) {
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        const body = await readJsonBody(request);

        if (!isClientRegistrationRequest(body)) {
          writeError(
            response,
            400,
            "invalid_client_registration",
            "Invalid client registration payload",
          );
          return;
        }

        const resolvedBaseUrl = resolveServiceBaseUrl(request, body);
        const client = clients.register(body, resolvedBaseUrl);
        const payload: ClientRegistrationResponse = {
          clientId: client.clientId,
          callbackUrl: client.callbackUrl,
          heartbeatIntervalMs: config.clientHeartbeatIntervalMs,
        };

        writeJson(response, 200, payload);
        return;
      }

      const clientHeartbeatMatch = /^\/clients\/([^/]+)\/heartbeat$/.exec(
        url.pathname,
      );

      if (request.method === "POST" && clientHeartbeatMatch) {
        if (!hasClientKey(request.headers["x-client-key"], config)) {
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        const body = await readJsonBody(request);

        if (
          !isClientHeartbeatRequest(body) ||
          body.clientId !== clientHeartbeatMatch[1]
        ) {
          writeError(
            response,
            400,
            "invalid_client_heartbeat",
            "Invalid client heartbeat payload",
          );
          return;
        }

        const client = clients.heartbeat(body);

        if (!client) {
          writeError(response, 404, "client_not_found", "Client is not registered");
          return;
        }

        writeJson(response, 200, {
          ok: true,
          client,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/workers/register") {
        const ipAddress = resolveDirectRequestAddress(request);

        if (workerRegistrationGuard.isBanned(ipAddress)) {
          writeError(
            response,
            403,
            "worker_registration_ip_banned",
            "Worker registration source IP is banned until coordinator restart",
          );
          return;
        }

        if (!hasWorkerKey(request.headers["x-worker-key"], config)) {
          const attempt = workerRegistrationGuard.registerFailure(ipAddress);

          if (attempt.banned) {
            console.warn(
              `[coordinator] Worker registration IP ${ipAddress} banned after ${attempt.failedAttempts} invalid key attempts`,
            );
            writeError(
              response,
              403,
              "worker_registration_ip_banned",
              "Worker registration source IP is banned until coordinator restart",
            );
            return;
          }

          console.warn(
            `[coordinator] Invalid worker registration key from ${ipAddress}; attempt ${attempt.failedAttempts}/${config.workerRegistrationMaxInvalidAttempts}`,
          );
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        workerRegistrationGuard.clear(ipAddress);

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

        const resolvedBaseUrl = resolveServiceBaseUrl(request, body);
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

function hasClientKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.clientRegistrationKey;
}

function resolveJobCallback(
  request: CreateTryOnJobRequest,
  clients: ClientRegistry,
): CreateTryOnJobRequest | undefined {
  if (request.callbackUrl || !request.sourceClientId) {
    return request;
  }

  const client = clients.get(request.sourceClientId);

  if (!client) {
    return undefined;
  }

  return {
    ...request,
    callbackUrl: client.callbackUrl,
  };
}

function resolveServiceBaseUrl(
  request: IncomingMessage,
  registration: WorkerRegistrationRequest | ClientRegistrationRequest,
): string {
  if (registration.publicUrl) {
    return registration.publicUrl.replace(/\/$/, "");
  }

  const protocol = registration.publicProtocol ?? "http";
  const host = resolveRequesterHost(request);

  return `${protocol}://${formatHostForUrl(host)}:${registration.port}`;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
