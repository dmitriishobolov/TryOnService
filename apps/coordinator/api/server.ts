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
import type {
  SecurityAuditEvent,
  SecurityAuditStore,
} from "../security/auditStore.js";
import type {
  RegistrationBanScope,
  RegistrationBanStore,
} from "../security/registrationBanStore.js";
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
  audit: SecurityAuditStore;
  registrationBans: RegistrationBanStore;
  workerRegistrationGuard: IpBanGuard;
  storageRegistrationGuard: IpBanGuard;
  clientRegistrationGuard: IpBanGuard;
  scheduler: Scheduler;
}

export function createCoordinatorServer(deps: CoordinatorServerDeps): Server {
  const {
    config,
    jobs,
    workers,
    clients,
    storageNodes,
    audit,
    registrationBans,
    workerRegistrationGuard,
    storageRegistrationGuard,
    clientRegistrationGuard,
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

      if (request.method === "GET" && url.pathname === "/security/events") {
        if (!hasAdminKey(request.headers["x-admin-key"], config)) {
          writeError(response, 401, "unauthorized_admin", "Invalid admin key");
          return;
        }

        writeJson(response, 200, {
          events: await audit.list(readAuditLimit(url.searchParams.get("limit"))),
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
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isCreateTryOnJobRequest(body)) {
          writeError(response, 400, "invalid_job_request", "Invalid job payload");
          return;
        }

        if (
          !hasClientAccess(
            request.headers["x-client-key"],
            body.sourceClientId,
            config,
          )
        ) {
          recordSecurityEvent(audit, {
            eventType: "client_job_unauthorized",
            severity: "warning",
            ipAddress: requesterIp,
            actorType: "client",
            actorId: body.sourceClientId,
          });
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        const inputFilesStoragePrefix = resolveInputFilesStoragePrefix(
          body.payload.inputFiles,
          body.sourceClientId,
        );

        if (!inputFilesStoragePrefix.valid) {
          recordSecurityEvent(audit, {
            eventType: "input_files_prefix_forbidden",
            severity: "warning",
            ipAddress: requesterIp,
            actorType: "client",
            actorId: body.sourceClientId,
            metadata: {
              message: inputFilesStoragePrefix.message,
            },
          });
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
            keyVersion: config.workerDispatchSigningKeyVersion,
            jobId: job.id,
            workerId: reservedWorker.workerId,
            expiresAt: dispatchTokenExpiresAt,
          },
          config.workerDispatchSigningKey,
        );
        const callbackToken = createDispatchToken(
          {
            purpose: "client-callback",
            keyVersion: config.clientCallbackSigningKeyVersion,
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

        recordSecurityEvent(audit, {
          eventType: "job_assignment_issued",
          severity: "info",
          ipAddress: requesterIp,
          actorType: "client",
          actorId: requestWithCallback.sourceClientId,
          resourceType: "job",
          resourceId: job.id,
          metadata: {
            workerId: reservedWorker.workerId,
            storageId: storageAccess.storageId,
          },
        });

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
            !hasClientAccess(
              request.headers["x-client-key"],
              body.requesterId,
              config,
            )) ||
          (body.requesterType === "worker" &&
            !hasWorkerServiceAccess(
              request.headers["x-worker-service-key"],
              body.requesterId,
              config,
            ))
        ) {
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

        const storageKeyPrefix = resolveStorageAccessKeyPrefix(body);

        if (!storageKeyPrefix) {
          recordSecurityEvent(audit, {
            eventType: "storage_prefix_forbidden",
            severity: "warning",
            ipAddress: requesterIp,
            actorType: body.requesterType,
            actorId: body.requesterId,
            metadata: {
              requestedPrefix: body.keyPrefix,
            },
          });
          writeError(
            response,
            403,
            "storage_prefix_forbidden",
            "Storage key prefix is outside requester ownership",
          );
          return;
        }

        const storageAccess = await createStorageAccessAssignment(
          storageNodes,
          config,
          {
            requesterId: body.requesterId,
            scope: body.scope,
            storageId: body.storageId,
            keyPrefix: storageKeyPrefix,
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

        recordSecurityEvent(audit, {
          eventType: "storage_access_issued",
          severity: "info",
          ipAddress: requesterIp,
          actorType: body.requesterType,
          actorId: body.requesterId,
          resourceType: "storage",
          resourceId: storageAccess.storageId,
          metadata: {
            scope: storageAccess.scope,
            keyPrefix: storageAccess.keyPrefix,
          },
        });

        writeJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/storage/register") {
        const ipAddress = resolveDirectRequestAddress(request);

        if (storageRegistrationGuard.isBanned(ipAddress)) {
          recordSecurityEvent(audit, {
            eventType: "storage_registration_ip_banned",
            severity: "critical",
            ipAddress,
            actorType: "storage",
          });
          writeError(
            response,
            403,
            "storage_registration_ip_banned",
            "Storage registration source IP is banned",
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
            persistRegistrationBan(registrationBans, "storage", ipAddress);
            recordSecurityEvent(audit, {
              eventType: "storage_registration_ip_banned",
              severity: "critical",
              ipAddress,
              actorType: "storage",
              metadata: {
                failedAttempts: attempt.failedAttempts,
              },
            });
            writeError(
              response,
              403,
              "storage_registration_ip_banned",
              "Storage registration source IP is banned",
            );
            return;
          }

          console.warn(
            `[coordinator] Invalid storage registration key from ${ipAddress}; attempt ${attempt.failedAttempts}/${config.storageRegistrationMaxInvalidAttempts}`,
          );
          recordSecurityEvent(audit, {
            eventType: "invalid_storage_registration_key",
            severity: "warning",
            ipAddress,
            actorType: "storage",
            metadata: {
              failedAttempts: attempt.failedAttempts,
            },
          });
          writeError(response, 401, "unauthorized_storage", "Invalid storage key");
          return;
        }

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

        if (config.requireStorageInstanceKeys && !config.storageKeys[body.storageId]) {
          const attempt = storageRegistrationGuard.registerFailure(ipAddress);

          if (attempt.banned) {
            persistRegistrationBan(registrationBans, "storage", ipAddress);
          }

          recordSecurityEvent(audit, {
            eventType: attempt.banned
              ? "storage_registration_ip_banned"
              : "storage_instance_key_required",
            severity: attempt.banned ? "critical" : "warning",
            ipAddress,
            actorType: "storage",
            actorId: body.storageId,
            metadata: {
              failedAttempts: attempt.failedAttempts,
            },
          });
          writeError(
            response,
            403,
            attempt.banned
              ? "storage_registration_ip_banned"
              : "storage_instance_key_required",
            attempt.banned
              ? "Storage registration source IP is banned"
              : "Storage node is not configured with a per-instance key",
          );
          return;
        }

        if (
          !hasStorageServiceAccess(
            request.headers["x-storage-service-key"],
            body.storageId,
            config,
          )
        ) {
          const attempt = storageRegistrationGuard.registerFailure(ipAddress);

          if (attempt.banned) {
            persistRegistrationBan(registrationBans, "storage", ipAddress);
          }

          recordSecurityEvent(audit, {
            eventType: attempt.banned
              ? "storage_registration_ip_banned"
              : "invalid_storage_service_key",
            severity: attempt.banned ? "critical" : "warning",
            ipAddress,
            actorType: "storage",
            actorId: body.storageId,
            metadata: {
              failedAttempts: attempt.failedAttempts,
            },
          });
          writeError(
            response,
            attempt.banned ? 403 : 401,
            attempt.banned
              ? "storage_registration_ip_banned"
              : "unauthorized_storage_instance",
            attempt.banned
              ? "Storage registration source IP is banned"
              : "Invalid storage instance key",
          );
          return;
        }

        if (config.requireHttpsEndpoints && !isHttpsRegistration(body)) {
          recordSecurityEvent(audit, {
            eventType: "insecure_storage_registration",
            severity: "warning",
            ipAddress,
            actorType: "storage",
            actorId: body.storageId,
          });
          writeError(
            response,
            400,
            "insecure_storage_endpoint",
            "Storage registration requires an https public endpoint",
          );
          return;
        }

        storageRegistrationGuard.clear(ipAddress);

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
        const ipAddress = resolveDirectRequestAddress(request);

        if (clientRegistrationGuard.isBanned(ipAddress)) {
          recordSecurityEvent(audit, {
            eventType: "client_registration_ip_banned",
            severity: "critical",
            ipAddress,
            actorType: "client",
          });
          writeError(
            response,
            403,
            "client_registration_ip_banned",
            "Client registration source IP is banned",
          );
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

        if (
          !hasClientAccess(request.headers["x-client-key"], body.clientId, config)
        ) {
          const attempt = clientRegistrationGuard.registerFailure(ipAddress);

          if (attempt.banned) {
            console.warn(
              `[coordinator] Client registration IP ${ipAddress} banned after ${attempt.failedAttempts} invalid key attempts`,
            );
            persistRegistrationBan(registrationBans, "client", ipAddress);
            recordSecurityEvent(audit, {
              eventType: "client_registration_ip_banned",
              severity: "critical",
              ipAddress,
              actorType: "client",
              actorId: body.clientId,
              metadata: {
                failedAttempts: attempt.failedAttempts,
              },
            });
            writeError(
              response,
              403,
              "client_registration_ip_banned",
              "Client registration source IP is banned",
            );
            return;
          }

          console.warn(
            `[coordinator] Invalid client registration key from ${ipAddress}; attempt ${attempt.failedAttempts}/${config.clientRegistrationMaxInvalidAttempts}`,
          );
          recordSecurityEvent(audit, {
            eventType: "invalid_client_registration_key",
            severity: "warning",
            ipAddress,
            actorType: "client",
            actorId: body.clientId,
            metadata: {
              failedAttempts: attempt.failedAttempts,
            },
          });
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        clientRegistrationGuard.clear(ipAddress);

        if (config.requireHttpsEndpoints && !isHttpsRegistration(body)) {
          recordSecurityEvent(audit, {
            eventType: "insecure_client_registration",
            severity: "warning",
            ipAddress,
            actorType: "client",
            actorId: body.clientId,
          });
          writeError(
            response,
            400,
            "insecure_client_endpoint",
            "Client registration requires an https public endpoint",
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
        if (
          !hasStorageServiceAccess(
            request.headers["x-storage-service-key"],
            storageHeartbeatMatch[1],
            config,
          )
        ) {
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

        if (
          !hasClientAccess(
            request.headers["x-client-key"],
            clientHeartbeatMatch[1],
            config,
          )
        ) {
          writeError(response, 401, "unauthorized_client", "Invalid client key");
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
          recordSecurityEvent(audit, {
            eventType: "worker_registration_ip_banned",
            severity: "critical",
            ipAddress,
            actorType: "worker",
          });
          writeError(
            response,
            403,
            "worker_registration_ip_banned",
            "Worker registration source IP is banned",
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
            persistRegistrationBan(registrationBans, "worker", ipAddress);
            recordSecurityEvent(audit, {
              eventType: "worker_registration_ip_banned",
              severity: "critical",
              ipAddress,
              actorType: "worker",
              metadata: {
                failedAttempts: attempt.failedAttempts,
              },
            });
            writeError(
              response,
              403,
              "worker_registration_ip_banned",
              "Worker registration source IP is banned",
            );
            return;
          }

          console.warn(
            `[coordinator] Invalid worker registration key from ${ipAddress}; attempt ${attempt.failedAttempts}/${config.workerRegistrationMaxInvalidAttempts}`,
          );
          recordSecurityEvent(audit, {
            eventType: "invalid_worker_registration_key",
            severity: "warning",
            ipAddress,
            actorType: "worker",
            metadata: {
              failedAttempts: attempt.failedAttempts,
            },
          });
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

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

        if (config.requireWorkerInstanceKeys && !config.workerKeys[body.workerId]) {
          const attempt = workerRegistrationGuard.registerFailure(ipAddress);

          if (attempt.banned) {
            persistRegistrationBan(registrationBans, "worker", ipAddress);
          }

          recordSecurityEvent(audit, {
            eventType: attempt.banned
              ? "worker_registration_ip_banned"
              : "worker_instance_key_required",
            severity: attempt.banned ? "critical" : "warning",
            ipAddress,
            actorType: "worker",
            actorId: body.workerId,
            metadata: {
              failedAttempts: attempt.failedAttempts,
            },
          });
          writeError(
            response,
            403,
            attempt.banned
              ? "worker_registration_ip_banned"
              : "worker_instance_key_required",
            attempt.banned
              ? "Worker registration source IP is banned"
              : "Worker is not configured with a per-instance key",
          );
          return;
        }

        if (
          !hasWorkerServiceAccess(
            request.headers["x-worker-service-key"],
            body.workerId,
            config,
          )
        ) {
          const attempt = workerRegistrationGuard.registerFailure(ipAddress);

          if (attempt.banned) {
            persistRegistrationBan(registrationBans, "worker", ipAddress);
          }

          recordSecurityEvent(audit, {
            eventType: attempt.banned
              ? "worker_registration_ip_banned"
              : "invalid_worker_service_key",
            severity: attempt.banned ? "critical" : "warning",
            ipAddress,
            actorType: "worker",
            actorId: body.workerId,
            metadata: {
              failedAttempts: attempt.failedAttempts,
            },
          });
          writeError(
            response,
            attempt.banned ? 403 : 401,
            attempt.banned
              ? "worker_registration_ip_banned"
              : "unauthorized_worker_instance",
            attempt.banned
              ? "Worker registration source IP is banned"
              : "Invalid worker instance key",
          );
          return;
        }

        if (config.requireHttpsEndpoints && !isHttpsRegistration(body)) {
          recordSecurityEvent(audit, {
            eventType: "insecure_worker_registration",
            severity: "warning",
            ipAddress,
            actorType: "worker",
            actorId: body.workerId,
          });
          writeError(
            response,
            400,
            "insecure_worker_endpoint",
            "Worker registration requires an https public endpoint",
          );
          return;
        }

        workerRegistrationGuard.clear(ipAddress);

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
        if (
          !hasWorkerServiceAccess(
            request.headers["x-worker-service-key"],
            heartbeatMatch[1],
            config,
          )
        ) {
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

        const previous = await jobs.get(body.jobId);

        if (!previous?.assignedWorkerId) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        if (
          !hasWorkerServiceAccess(
            request.headers["x-worker-service-key"],
            previous.assignedWorkerId,
            config,
          )
        ) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
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

        if (!previous?.assignedWorkerId) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        if (
          !hasWorkerServiceAccess(
            request.headers["x-worker-service-key"],
            previous.assignedWorkerId,
            config,
          )
        ) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

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

function hasWorkerServiceAccess(
  headerValue: string | string[] | undefined,
  workerId: string,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const workerKey = config.workerKeys[workerId];

  if (workerKey) {
    return value === workerKey;
  }

  if (config.requireWorkerInstanceKeys) {
    return false;
  }

  return value === config.workerServiceKey;
}

function hasStorageRegistrationKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.storageRegistrationKey;
}

function hasStorageServiceAccess(
  headerValue: string | string[] | undefined,
  storageId: string,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const storageKey = config.storageKeys[storageId];

  if (storageKey) {
    return value === storageKey;
  }

  if (config.requireStorageInstanceKeys) {
    return false;
  }

  return value === config.storageServiceKey;
}

function hasClientAccess(
  headerValue: string | string[] | undefined,
  clientId: string,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const clientKey = config.clientKeys[clientId];

  if (clientKey) {
    return value === clientKey;
  }

  if (config.requireClientInstanceKeys) {
    return false;
  }

  return value === config.clientRegistrationKey;
}

function hasAdminKey(
  headerValue: string | string[] | undefined,
  config: CoordinatorConfig,
): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return value === config.adminApiKey;
}

function recordSecurityEvent(
  audit: SecurityAuditStore,
  event: SecurityAuditEvent,
): void {
  void audit.record(event).catch((error) => {
    console.error("[coordinator] Failed to record security audit event", error);
  });
}

function persistRegistrationBan(
  registrationBans: RegistrationBanStore,
  scope: RegistrationBanScope,
  ipAddress: string,
): void {
  void registrationBans
    .ban({
      scope,
      ipAddress,
      bannedAt: new Date().toISOString(),
    })
    .catch((error) => {
      console.error("[coordinator] Failed to persist registration ban", error);
    });
}

function readAuditLimit(raw: string | null): number {
  if (!raw) {
    return 100;
  }

  const value = Number(raw);

  return Number.isInteger(value) && value > 0 && value <= 1_000 ? value : 100;
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
      "x-worker-service-key": resolveWorkerServiceKey(worker.workerId, config),
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
      "x-worker-service-key": resolveWorkerServiceKey(worker.workerId, config),
    },
    {
      retries: config.httpClientRetries,
      timeoutMs: config.httpClientTimeoutMs,
    },
  );
}

function resolveWorkerServiceKey(
  workerId: string,
  config: CoordinatorConfig,
): string {
  return config.workerKeys[workerId] ?? config.workerServiceKey;
}

function resolveRequiredCapabilities(request: CreateTryOnJobRequest): string[] {
  if (request.payload.command === "request") {
    return ["try-on.mock"];
  }

  return [];
}

function resolveStorageAccessKeyPrefix(
  request: {
    requesterId: string;
    requesterType: "client" | "worker";
    keyPrefix?: string;
  },
): string | undefined {
  try {
    const requesterId = sanitizeStorageRequesterId(request.requesterId);
    const rawPrefix =
      request.keyPrefix ?? `${request.requesterType}s/${requesterId}`;
    const keyPrefix = normalizeStorageKey(rawPrefix);

    if (request.requesterType === "client") {
      const allowedPrefix = `clients/${requesterId}`;

      return keyPrefix === allowedPrefix || keyPrefix.startsWith(`${allowedPrefix}/`)
        ? keyPrefix
        : undefined;
    }

    const workerPrefix = `workers/${requesterId}`;

    return keyPrefix === workerPrefix ||
      keyPrefix.startsWith(`${workerPrefix}/`) ||
      keyPrefix === "jobs" ||
      keyPrefix.startsWith("jobs/")
      ? keyPrefix
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeStorageRequesterId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function isHttpsRegistration(
  registration:
    | WorkerRegistrationRequest
    | ClientRegistrationRequest
    | StorageRegistrationRequest,
): boolean {
  if (registration.publicUrl) {
    return registration.publicUrl.startsWith("https://");
  }

  return registration.publicProtocol === "https";
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
  sourceClientId: string,
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

    const clientPrefix = `clients/${sanitizeStorageRequesterId(sourceClientId)}`;

    if (keyPrefix !== clientPrefix && !keyPrefix.startsWith(`${clientPrefix}/`)) {
      return {
        valid: false,
        message: "Input files must be inside the source client storage namespace",
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
      keyVersion: config.storageAccessSigningKeyVersion,
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
