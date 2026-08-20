import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";

import {
  isClientHeartbeatRequest,
  isClientRegistrationRequest,
  isCreateTryOnJobRequest,
  isJobProgressUpdateRequest,
  isJobResultUpdateRequest,
  isStorageAccessRequest,
  isStorageHeartbeatRequest,
  isStorageRegistrationRequest,
  isWorkerHeartbeatRequest,
  isWorkerRegistrationRequest,
  type ClientRegistrationRequest,
  type ClientRegistrationResponse,
  type CreateTryOnJobRequest,
  type RegisteredWorker,
  type RegisteredStorageNode,
  type StorageAccessAssignment,
  type StorageAccessResponse,
  type StorageObjectRef,
  type StorageRegistrationRequest,
  type StorageRegistrationResponse,
  type WorkerAssignmentPrepareRequest,
  type WorkerAssignmentPrepareResponse,
  type TryOnJobAssignmentResponse,
  type WorkerJobRequest,
  type WorkerRegistrationRequest,
  type WorkerRegistrationResponse,
} from "../../shared/contracts/index.js";
import { createDispatchToken } from "../../shared/dispatchToken.js";
import {
  writeCaughtError,
  readJsonBody,
  postJson,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import { FixedWindowRateLimiter } from "../../shared/rateLimit.js";
import { normalizeStorageKey } from "../../shared/storage/index.js";
import type { CoordinatorConfig } from "../config/index.js";
import type { JobStore } from "../jobs/store.js";
import type { ClientRegistryStore } from "../registry/clientStore.js";
import type { StorageRegistryStore } from "../registry/storageStore.js";
import type { WorkerRegistryStore } from "../registry/store.js";
import type { Scheduler } from "../scheduler/index.js";
import type { IpBanGuard } from "../utils/ipBanGuard.js";
import {
  resolveDirectRequestAddress,
  resolveRequesterHost,
} from "../utils/requestAddress.js";

interface CoordinatorServerDeps {
  config: CoordinatorConfig;
  jobs: JobStore;
  workers: WorkerRegistryStore;
  clients: ClientRegistryStore;
  storageNodes: StorageRegistryStore;
  workerRegistrationGuard: IpBanGuard;
  storageRegistrationGuard: IpBanGuard;
  scheduler: Scheduler;
}

export function createCoordinatorServer(deps: CoordinatorServerDeps): Server {
  const {
    config,
    jobs,
    workers,
    clients,
    storageNodes,
    workerRegistrationGuard,
    storageRegistrationGuard,
    scheduler,
  } = deps;
  const rateLimiter = new FixedWindowRateLimiter(
    config.apiRateLimitMaxRequests,
    config.apiRateLimitWindowMs,
  );
  setInterval(() => {
    rateLimiter.cleanup();
  }, config.apiRateLimitWindowMs).unref();

  return createServer(async (request, response) => {
    const url = requestUrl(request);
    const requesterIp = resolveDirectRequestAddress(request);
    const rateLimit = rateLimiter.consume(requesterIp);

    try {
      if (!rateLimit.allowed) {
        writeError(response, 429, "rate_limited", "Too many requests");
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        if (!hasAdminKey(request.headers["x-admin-key"], config)) {
          writeError(response, 401, "unauthorized_admin", "Invalid admin key");
          return;
        }

        const [workerList, clientList, storageNodeList, queuedJobs] =
          await Promise.all([
            workers.list(),
            clients.list(),
            storageNodes.list(),
            jobs.findQueued(),
          ]);

        writeJson(response, 200, {
          status: "ok",
          workers: workerList,
          clients: clientList,
          storageNodes: storageNodeList,
          queuedJobs: queuedJobs.length,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/jobs") {
        if (!hasAdminKey(request.headers["x-admin-key"], config)) {
          writeError(response, 401, "unauthorized_admin", "Invalid admin key");
          return;
        }

        writeJson(response, 200, {
          jobs: await jobs.list(),
        });
        return;
      }

      const getJobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname);

      if (request.method === "GET" && getJobMatch) {
        if (!hasAdminKey(request.headers["x-admin-key"], config)) {
          writeError(response, 401, "unauthorized_admin", "Invalid admin key");
          return;
        }

        const job = await jobs.get(getJobMatch[1]);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        writeJson(response, 200, job);
        return;
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        if (!hasClientKey(request.headers["x-client-key"], config)) {
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isCreateTryOnJobRequest(body)) {
          writeError(response, 400, "invalid_job_request", "Invalid job payload");
          return;
        }

        const inputFilesStoragePrefix = resolveInputFilesStoragePrefix(
          body.payload.inputFiles,
        );

        if (!inputFilesStoragePrefix.valid) {
          writeError(
            response,
            400,
            "input_files_not_scoped",
            inputFilesStoragePrefix.message,
          );
          return;
        }

        const requestWithCallback = await resolveJobCallback(body, clients);

        if (!requestWithCallback) {
          writeError(
            response,
            409,
            "client_not_registered",
            "Source client is not registered or ready",
          );
          return;
        }

        const requiredCapabilities = resolveRequiredCapabilities(body);
        const worker = await workers.findAvailable(
          config.workerHeartbeatTimeoutMs,
          requiredCapabilities,
        );

        if (!worker) {
          writeError(
            response,
            503,
            "no_available_worker",
            "No worker is currently available for this job",
          );
          return;
        }

        const reservedWorker = await workers.reserve(worker.workerId);

        if (!reservedWorker) {
          writeError(
            response,
            409,
            "worker_not_available",
            "Selected worker is no longer available",
          );
          return;
        }

        const dispatchTokenExpiresAt = new Date(
          Date.now() + config.workerDispatchTokenTtlMs,
        ).toISOString();
        const callbackTokenExpiresAt = new Date(
          Date.now() + config.clientCallbackTokenTtlMs,
        ).toISOString();
        const job = await jobs.createAssigned(
          requestWithCallback,
          reservedWorker.workerId,
          dispatchTokenExpiresAt,
        );
        const workerRequest = createWorkerJobRequest(
          job.id,
          requestWithCallback,
          config,
        );
        const storageAccess = await createStorageAccessAssignment(
          storageNodes,
          config,
          resolveJobStorageAccessRequest(
            job.id,
            reservedWorker.workerId,
            inputFilesStoragePrefix.storageId,
            inputFilesStoragePrefix.keyPrefix,
          ),
        );

        if (!storageAccess) {
          await workers.release(reservedWorker.workerId);
          await jobs.markFailed(job.id, {
            code: "no_available_storage",
            message: "No object storage node is currently available",
            retryable: true,
          });
          writeError(
            response,
            503,
            "no_available_storage",
            "No object storage node is currently available",
          );
          return;
        }

        workerRequest.storage = storageAccess;
        const dispatchToken = createDispatchToken(
          {
            purpose: "worker-dispatch",
            jobId: job.id,
            workerId: reservedWorker.workerId,
            expiresAt: dispatchTokenExpiresAt,
          },
          config.workerDispatchSigningKey,
        );
        const callbackToken = createDispatchToken(
          {
            purpose: "client-callback",
            jobId: job.id,
            clientId: requestWithCallback.sourceClientId,
            expiresAt: callbackTokenExpiresAt,
          },
          config.clientCallbackSigningKey,
        );

        try {
          const prepared = await prepareWorkerAssignment(
            reservedWorker,
            job.id,
            requestWithCallback,
            requiredCapabilities,
            dispatchTokenExpiresAt,
            callbackToken,
            callbackTokenExpiresAt,
            config,
          );

          if (!prepared.accepted) {
            throw new Error("Worker rejected assignment preparation");
          }
        } catch (error) {
          await workers.release(reservedWorker.workerId);
          void cancelWorkerAssignment(reservedWorker, job.id, config).catch(
            (cancelError) => {
              console.error(
                `[coordinator] Failed to cancel prepared job ${job.id} on worker ${reservedWorker.workerId}`,
                cancelError,
              );
            },
          );
          await jobs.markFailed(job.id, {
            code: "worker_prepare_failed",
            message:
              error instanceof Error
                ? error.message
                : "Worker failed to prepare assignment",
            retryable: true,
          });
          console.error(
            `[coordinator] Failed to prepare job ${job.id} on worker ${reservedWorker.workerId}`,
            error,
          );
          writeError(
            response,
            502,
            "worker_prepare_failed",
            "Worker failed to prepare assignment",
          );
          return;
        }

        const assignment: TryOnJobAssignmentResponse = {
          job,
          worker: {
            workerId: reservedWorker.workerId,
            baseUrl: reservedWorker.baseUrl,
            jobUrl: `${reservedWorker.baseUrl}/jobs`,
            dispatchToken,
            dispatchTokenExpiresAt,
          },
          storage: storageAccess,
          workerRequest,
        };

        writeJson(response, 201, assignment);
        return;
      }

      if (request.method === "POST" && url.pathname === "/storage/access") {
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isStorageAccessRequest(body)) {
          writeError(
            response,
            400,
            "invalid_storage_access",
            "Invalid storage access payload",
          );
          return;
        }

        if (
          (body.requesterType === "client" &&
            !hasClientKey(request.headers["x-client-key"], config)) ||
          (body.requesterType === "worker" &&
            !hasWorkerServiceKey(request.headers["x-worker-service-key"], config))
        ) {
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        const storageAccess = await createStorageAccessAssignment(
          storageNodes,
          config,
          {
            requesterId: body.requesterId,
            scope: body.scope,
            storageId: body.storageId,
            keyPrefix:
              body.keyPrefix ??
              `${body.requesterType}/${body.requesterId.replace(/[^a-zA-Z0-9._-]/g, "-")}/`,
          },
        );

        if (!storageAccess) {
          writeError(
            response,
            503,
            "no_available_storage",
            "No object storage node is currently available",
          );
          return;
        }

        const payload: StorageAccessResponse = {
          storage: storageAccess,
        };

        writeJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/storage/register") {
        const ipAddress = resolveDirectRequestAddress(request);

        if (storageRegistrationGuard.isBanned(ipAddress)) {
          writeError(
            response,
            403,
            "storage_registration_ip_banned",
            "Storage registration source IP is banned until coordinator restart",
          );
          return;
        }

        if (
          !hasStorageRegistrationKey(
            request.headers["x-storage-registration-key"],
            config,
          )
        ) {
          const attempt = storageRegistrationGuard.registerFailure(ipAddress);

          if (attempt.banned) {
            console.warn(
              `[coordinator] Storage registration IP ${ipAddress} banned after ${attempt.failedAttempts} invalid key attempts`,
            );
            writeError(
              response,
              403,
              "storage_registration_ip_banned",
              "Storage registration source IP is banned until coordinator restart",
            );
            return;
          }

          console.warn(
            `[coordinator] Invalid storage registration key from ${ipAddress}; attempt ${attempt.failedAttempts}/${config.storageRegistrationMaxInvalidAttempts}`,
          );
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        storageRegistrationGuard.clear(ipAddress);

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isStorageRegistrationRequest(body)) {
          writeError(
            response,
            400,
            "invalid_storage_registration",
            "Invalid storage registration payload",
          );
          return;
        }

        const resolvedBaseUrl = resolveServiceBaseUrl(request, body);
        const storageNode = await storageNodes.register(body, resolvedBaseUrl);
        const payload: StorageRegistrationResponse = {
          storageId: storageNode.storageId,
          heartbeatIntervalMs: config.storageHeartbeatIntervalMs,
        };

        writeJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/clients/register") {
        if (!hasClientKey(request.headers["x-client-key"], config)) {
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

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
        const client = await clients.register(body, resolvedBaseUrl);
        const payload: ClientRegistrationResponse = {
          clientId: client.clientId,
          callbackUrl: client.callbackUrl,
          heartbeatIntervalMs: config.clientHeartbeatIntervalMs,
        };

        writeJson(response, 200, payload);
        return;
      }

      const storageHeartbeatMatch = /^\/storage\/([^/]+)\/heartbeat$/.exec(
        url.pathname,
      );

      if (request.method === "POST" && storageHeartbeatMatch) {
        if (!hasStorageServiceKey(request.headers["x-storage-service-key"], config)) {
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (
          !isStorageHeartbeatRequest(body) ||
          body.storageId !== storageHeartbeatMatch[1]
        ) {
          writeError(
            response,
            400,
            "invalid_storage_heartbeat",
            "Invalid storage heartbeat payload",
          );
          return;
        }

        const storageNode = await storageNodes.heartbeat(body);

        if (!storageNode) {
          writeError(
            response,
            404,
            "storage_not_found",
            "Storage node is not registered",
          );
          return;
        }

        if (storageNode.status === "offline") {
          await storageNodes.markOffline(storageNode.storageId);
        }

        writeJson(response, 200, {
          ok: true,
          storage: storageNode,
        });
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

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

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

        const client = await clients.heartbeat(body);

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

        if (
          !hasWorkerRegistrationKey(
            request.headers["x-worker-registration-key"],
            config,
          )
        ) {
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

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

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
        const worker = await workers.register(body, resolvedBaseUrl);
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
        if (!hasWorkerServiceKey(request.headers["x-worker-service-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isWorkerHeartbeatRequest(body) || body.workerId !== heartbeatMatch[1]) {
          writeError(
            response,
            400,
            "invalid_worker_heartbeat",
            "Invalid worker heartbeat payload",
          );
          return;
        }

        const worker = await workers.heartbeat(body);

        if (!worker) {
          writeError(response, 404, "worker_not_found", "Worker is not registered");
          return;
        }

        if (worker.status === "offline") {
          await failActiveJobsForWorker(worker.workerId, jobs);
          await workers.markOffline(worker.workerId);
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
        if (!hasWorkerServiceKey(request.headers["x-worker-service-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isJobProgressUpdateRequest(body) || body.jobId !== progressMatch[1]) {
          writeError(
            response,
            400,
            "invalid_job_progress",
            "Invalid job progress payload",
          );
          return;
        }

        const job = await jobs.markRunning(body);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        writeJson(response, 200, job);
        return;
      }

      const resultMatch = /^\/jobs\/([^/]+)\/result$/.exec(url.pathname);

      if (request.method === "POST" && resultMatch) {
        if (!hasWorkerServiceKey(request.headers["x-worker-service-key"], config)) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isJobResultUpdateRequest(body) || body.jobId !== resultMatch[1]) {
          writeError(
            response,
            400,
            "invalid_job_result",
            "Invalid job result payload",
          );
          return;
        }

        const previous = await jobs.get(body.jobId);
        const job = await jobs.markResult(body);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        if (
          previous?.assignedWorkerId &&
          previous.status !== "succeeded" &&
          previous.status !== "failed"
        ) {
          await workers.release(previous.assignedWorkerId);
        }

        void scheduler.schedule();

        writeJson(response, 200, job);
        return;
      }

      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      console.error("[coordinator] Unhandled request error", error);
      writeCaughtError(response, error);
    }
  });
}

function hasWorkerRegistrationKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.workerRegistrationKey;
}

function hasWorkerServiceKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.workerServiceKey;
}

function hasStorageRegistrationKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.storageRegistrationKey;
}

function hasStorageServiceKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.storageServiceKey;
}

function hasClientKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.clientRegistrationKey;
}

function hasAdminKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.adminApiKey;
}

async function resolveJobCallback(
  request: CreateTryOnJobRequest,
  clients: ClientRegistryStore,
): Promise<CreateTryOnJobRequest | undefined> {
  const client = await clients.get(request.sourceClientId);

  if (!client || client.status === "offline") {
    return undefined;
  }

  return {
    ...request,
    callbackUrl: client.callbackUrl,
  };
}

function createWorkerJobRequest(
  jobId: string,
  request: CreateTryOnJobRequest,
  config: CoordinatorConfig,
): WorkerJobRequest {
  return {
    jobId,
    client: request.client,
    payload: request.payload,
    callbackUrl: request.callbackUrl,
    coordinator: {
      progressUrl: `${config.publicUrl}/jobs/${jobId}/progress`,
      resultUrl: `${config.publicUrl}/jobs/${jobId}/result`,
    },
  };
}

function prepareWorkerAssignment(
  worker: RegisteredWorker,
  jobId: string,
  request: CreateTryOnJobRequest,
  requiredCapabilities: string[],
  dispatchTokenExpiresAt: string,
  callbackToken: string,
  callbackTokenExpiresAt: string,
  config: CoordinatorConfig,
): Promise<WorkerAssignmentPrepareResponse> {
  const payload: WorkerAssignmentPrepareRequest = {
    jobId,
    workerId: worker.workerId,
    sourceClientId: request.sourceClientId,
    client: request.client,
    callbackUrl: request.callbackUrl,
    requiredCapabilities,
    dispatchTokenExpiresAt,
    callbackToken,
    callbackTokenExpiresAt,
  };

  return postJson<WorkerAssignmentPrepareResponse>(
    `${worker.baseUrl}/assignments`,
    payload,
    {
      "x-worker-service-key": config.workerServiceKey,
    },
    {
      retries: config.httpClientRetries,
      timeoutMs: config.httpClientTimeoutMs,
    },
  );
}

function cancelWorkerAssignment(
  worker: RegisteredWorker,
  jobId: string,
  config: CoordinatorConfig,
): Promise<unknown> {
  return postJson(
    `${worker.baseUrl}/jobs/${jobId}/cancel`,
    {},
    {
      "x-worker-service-key": config.workerServiceKey,
    },
    {
      retries: config.httpClientRetries,
      timeoutMs: config.httpClientTimeoutMs,
    },
  );
}

function resolveRequiredCapabilities(request: CreateTryOnJobRequest): string[] {
  if (request.payload.command === "request") {
    return ["try-on.mock"];
  }

  return [];
}

function resolveJobStorageAccessRequest(
  jobId: string,
  workerId: string,
  storageId: string | undefined,
  inputFilesStoragePrefix: string | undefined,
): {
  requesterId: string;
  scope: StorageAccessAssignment["scope"];
  storageId?: string;
  keyPrefix: string;
} {
  if (inputFilesStoragePrefix) {
    return {
      requesterId: workerId,
      scope: "read",
      storageId,
      keyPrefix: inputFilesStoragePrefix,
    };
  }

  return {
    requesterId: workerId,
    scope: "read-write",
    keyPrefix: `jobs/${jobId}`,
  };
}

function resolveInputFilesStoragePrefix(
  inputFiles: StorageObjectRef[] | undefined,
):
  | { valid: true; storageId?: string; keyPrefix?: string }
  | { valid: false; message: string } {
  if (!inputFiles || inputFiles.length === 0) {
    return {
      valid: true,
    };
  }

  try {
    const storageIds = new Set(inputFiles.map((file) => file.storageId));

    if (
      storageIds.size !== 1 ||
      storageIds.has(undefined) ||
      storageIds.has("")
    ) {
      return {
        valid: false,
        message: "Input files must reference one registered storage node",
      };
    }

    const directories = inputFiles
      .map((file) => dirnameStorageKey(normalizeStorageKey(file.key)))
      .filter((directory): directory is string => Boolean(directory));

    if (directories.length !== inputFiles.length) {
      return {
        valid: false,
        message: "Input files must use valid keys with a shared storage prefix",
      };
    }

    const keyPrefix = commonStoragePrefix(directories);

    if (!keyPrefix) {
      return {
        valid: false,
        message: "Input files must use valid keys with a shared storage prefix",
      };
    }

    return {
      valid: true,
      storageId: inputFiles[0].storageId,
      keyPrefix,
    };
  } catch {
    return {
      valid: false,
      message: "Input files must use valid keys with a shared storage prefix",
    };
  }
}

function dirnameStorageKey(key: string): string | undefined {
  const index = key.lastIndexOf("/");

  if (index <= 0) {
    return undefined;
  }

  return key.slice(0, index);
}

function commonStoragePrefix(keys: string[]): string | undefined {
  const [first, ...rest] = keys;

  if (!first) {
    return undefined;
  }

  const commonParts = first.split("/");

  for (const key of rest) {
    const parts = key.split("/");

    while (
      commonParts.length > 0 &&
      parts.slice(0, commonParts.length).join("/") !== commonParts.join("/")
    ) {
      commonParts.pop();
    }
  }

  return commonParts.length > 0 ? commonParts.join("/") : undefined;
}

async function createStorageAccessAssignment(
  storageNodes: StorageRegistryStore,
  config: CoordinatorConfig,
  request: {
    requesterId: string;
    scope: StorageAccessAssignment["scope"];
    storageId?: string;
    keyPrefix?: string;
  },
): Promise<StorageAccessAssignment | undefined> {
  const storageNode = request.storageId
    ? await findAvailableStorageNodeById(
        storageNodes,
        request.storageId,
        config.storageHeartbeatTimeoutMs,
      )
    : await storageNodes.findAvailable(config.storageHeartbeatTimeoutMs);

  if (!storageNode) {
    return undefined;
  }

  return createStorageAccessForNode(storageNode, config, request);
}

async function findAvailableStorageNodeById(
  storageNodes: StorageRegistryStore,
  storageId: string,
  heartbeatTimeoutMs: number,
): Promise<RegisteredStorageNode | undefined> {
  const node = await storageNodes.get(storageId);

  if (!node || node.status === "offline") {
    return undefined;
  }

  const lastHeartbeatAt = new Date(node.lastHeartbeatAt).getTime();
  const hasFreshHeartbeat = Date.now() - lastHeartbeatAt <= heartbeatTimeoutMs;
  const hasSpace =
    node.capacityBytes === undefined ||
    node.usedBytes === undefined ||
    node.usedBytes < node.capacityBytes;

  return hasFreshHeartbeat && hasSpace ? node : undefined;
}

function createStorageAccessForNode(
  storageNode: RegisteredStorageNode,
  config: CoordinatorConfig,
  request: {
    requesterId: string;
    scope: StorageAccessAssignment["scope"];
    keyPrefix?: string;
  },
): StorageAccessAssignment {
  const accessTokenExpiresAt = new Date(
    Date.now() + config.storageAccessTokenTtlMs,
  ).toISOString();
  const accessToken = createDispatchToken(
    {
      purpose: "storage-access",
      storageId: storageNode.storageId,
      requesterId: request.requesterId,
      scope: request.scope,
      keyPrefix: request.keyPrefix,
      expiresAt: accessTokenExpiresAt,
    },
    config.storageAccessSigningKey,
  );

  return {
    storageId: storageNode.storageId,
    baseUrl: storageNode.baseUrl,
    objectBaseUrl: `${storageNode.baseUrl}/objects`,
    accessToken,
    accessTokenExpiresAt,
    scope: request.scope,
    keyPrefix: request.keyPrefix,
  };
}

async function failActiveJobsForWorker(
  workerId: string,
  jobs: JobStore,
): Promise<void> {
  for (const job of await jobs.findActiveByWorker(workerId)) {
    await jobs.markFailed(job.id, {
      code: "worker_offline",
      message: "Assigned worker went offline",
      retryable: true,
    });
  }
}

function resolveServiceBaseUrl(
  request: IncomingMessage,
  registration:
    | WorkerRegistrationRequest
    | ClientRegistrationRequest
    | StorageRegistrationRequest,
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
