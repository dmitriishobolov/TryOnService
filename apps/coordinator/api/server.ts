import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";

import {
  isClientHeartbeatRequest,
  isClientRegistrationRequest,
  isCreateTryOnJobRequest,
  isGarmentCatalogCategoriesRequest,
  isGarmentCatalogItem,
  isGarmentCatalogSearchRequest,
  isJobCancelRequest,
  isJobProgressUpdateRequest,
  isJobResultUpdateRequest,
  isStorageAccessRequest,
  isStorageCatalogEntry,
  isStorageCatalogLookupRequest,
  isStorageHeartbeatRequest,
  isStorageRegistrationRequest,
  isWorkerHeartbeatRequest,
  isWorkerRegistrationRequest,
  type ClientRegistrationRequest,
  type ClientRegistrationResponse,
  type CreateTryOnJobRequest,
  type GarmentCatalogCategoriesResponse,
  type GarmentCatalogItem,
  type GarmentCatalogSearchResponse,
  type JobCancelResponse,
  type RegisteredWorker,
  type RegisteredStorageNode,
  type StorageAccessAssignment,
  type StorageAccessResponse,
  type StorageCatalogLocation,
  type StorageCatalogLookupResponse,
  type StorageCatalogNodeLookupResponse,
  type StorageObjectRef,
  type StorageRegistrationRequest,
  type StorageRegistrationResponse,
  type WorkerAssignmentPrepareRequest,
  type WorkerAssignmentPrepareResponse,
  type TryOnJob,
  type TryOnJobAssignmentResponse,
  type TryOnJobCreateResponse,
  type TryOnJobQueuedResponse,
  type WorkerJobCancelResponse,
  type WorkerJobRequest,
  type WorkerRegistrationRequest,
  type WorkerRegistrationResponse,
} from "../../shared/contracts/index.js";
import { createDispatchToken } from "../../shared/dispatchToken.js";
import {
  HttpRequestError,
  writeCaughtError,
  readJsonBody,
  postJson,
  requestUrl,
  writeError,
  writeJson,
} from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
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

const logger = createLogger("coordinator");

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

      const assignmentMatch = /^\/jobs\/([^/]+)\/assignment$/.exec(url.pathname);

      if (request.method === "GET" && assignmentMatch) {
        if (!hasClientKey(request.headers["x-client-key"], config)) {
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        const sourceClientId = url.searchParams.get("sourceClientId");

        if (!sourceClientId) {
          writeError(
            response,
            400,
            "source_client_required",
            "sourceClientId query parameter is required",
          );
          return;
        }

        const job = await jobs.get(assignmentMatch[1]);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        logger.debug("Job assignment poll received", {
          jobId: job.id,
          sourceClientId,
          status: job.status,
          provider: job.payload.model?.provider ?? "mock",
          task: job.payload.model?.task,
        });

        if (job.sourceClientId !== sourceClientId) {
          recordSecurityEvent(audit, {
            eventType: "job_assignment_forbidden",
            severity: "warning",
            ipAddress: requesterIp,
            actorType: "client",
            actorId: sourceClientId,
            resourceType: "job",
            resourceId: job.id,
          });
          writeError(
            response,
            403,
            "job_assignment_forbidden",
            "Job does not belong to this client",
          );
          return;
        }

        if (job.status !== "queued") {
          writeError(
            response,
            409,
            "job_not_waiting_for_assignment",
            `Job is ${job.status}`,
          );
          return;
        }

        const inputFilesStoragePrefix = resolveInputFilesStoragePrefix(
          job.payload.inputFiles,
          job.sourceClientId,
        );

        if (!inputFilesStoragePrefix.valid) {
          await jobs.markFailed(job.id, {
            code: "input_files_not_scoped",
            message: inputFilesStoragePrefix.message,
            retryable: false,
          });
          writeError(
            response,
            400,
            "input_files_not_scoped",
            inputFilesStoragePrefix.message,
          );
          return;
        }

        const assignment = await assignJobIfPossible({
          job,
          config,
          jobs,
          workers,
          storageNodes,
          audit,
          requesterIp,
          inputFilesStoragePrefix,
          queueWaitLogLevel: "debug",
        });

        if (isQueuedJobResponse(assignment)) {
          logger.debug("Job still queued after assignment poll", {
            jobId: job.id,
            sourceClientId: job.sourceClientId,
            reason: assignment.reason,
            retryAfterMs: assignment.retryAfterMs,
          });
        } else {
          logger.info("Job assignment returned to client", {
            jobId: assignment.job.id,
            sourceClientId: assignment.job.sourceClientId,
            workerId: assignment.worker.workerId,
            storageId: assignment.storage?.storageId,
          });
        }

        writeJson(
          response,
          isQueuedJobResponse(assignment) ? 202 : 200,
          assignment,
        );
        return;
      }

      const getJobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname);

      const cancelJobMatch = /^\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);

      if (request.method === "POST" && cancelJobMatch) {
        if (!hasClientKey(request.headers["x-client-key"], config)) {
          writeError(response, 401, "unauthorized_client", "Invalid client key");
          return;
        }

        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isJobCancelRequest(body)) {
          writeError(response, 400, "invalid_job_cancel", "Invalid job cancel payload");
          return;
        }

        const job = await jobs.get(cancelJobMatch[1]);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        if (job.sourceClientId !== body.sourceClientId) {
          recordSecurityEvent(audit, {
            eventType: "job_cancel_forbidden",
            severity: "warning",
            ipAddress: requesterIp,
            actorType: "client",
            actorId: body.sourceClientId,
            resourceType: "job",
            resourceId: job.id,
          });
          writeError(
            response,
            403,
            "job_cancel_forbidden",
            "Job does not belong to this client",
          );
          return;
        }

        if (job.status === "cancelled") {
          const payload: JobCancelResponse = {
            ok: true,
            job,
            cancelled: false,
          };
          writeJson(response, 200, payload);
          return;
        }

        if (job.status !== "queued") {
          writeError(
            response,
            409,
            "job_not_waiting_for_assignment",
            `Job is ${job.status}`,
          );
          return;
        }

        const cancelledJob = await jobs.markResult({
          jobId: job.id,
          status: "cancelled",
          error: {
            code: "client_stopped_waiting",
            message:
              body.reason?.trim() ||
              "Client stopped waiting for queued assignment",
            retryable: true,
          },
        });

        if (!cancelledJob) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        logger.info("Queued job cancelled by client", {
          jobId: cancelledJob.id,
          sourceClientId: cancelledJob.sourceClientId,
          reason: body.reason,
        });
        recordSecurityEvent(audit, {
          eventType: "job_cancelled_by_client",
          severity: "info",
          ipAddress: requesterIp,
          actorType: "client",
          actorId: cancelledJob.sourceClientId,
          resourceType: "job",
          resourceId: cancelledJob.id,
        });

        const payload: JobCancelResponse = {
          ok: true,
          job: cancelledJob,
          cancelled: true,
        };
        writeJson(response, 200, payload);
        return;
      }

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

        logger.info("Job create request received", {
          sourceClientId: body.sourceClientId,
          provider: body.payload.model?.provider ?? "mock",
          task: body.payload.model?.task,
          inputFiles: body.payload.inputFiles?.length ?? 0,
          hasCallbackUrl: Boolean(body.callbackUrl),
        });

        if (
          !hasClientKey(request.headers["x-client-key"], config)
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

        const job = await jobs.create(requestWithCallback);
        logger.info("Job created", {
          jobId: job.id,
          sourceClientId: job.sourceClientId,
          provider: job.payload.model?.provider ?? "mock",
          task: job.payload.model?.task,
          inputFiles: job.payload.inputFiles?.length ?? 0,
          callbackUrl: job.callbackUrl,
        });
        const assignment = await assignJobIfPossible({
          job,
          config,
          jobs,
          workers,
          storageNodes,
          audit,
          requesterIp,
          inputFilesStoragePrefix,
        });

        if (isQueuedJobResponse(assignment)) {
          logger.info("Job queued after create", {
            jobId: job.id,
            sourceClientId: job.sourceClientId,
            reason: assignment.reason,
            retryAfterMs: assignment.retryAfterMs,
          });
          recordSecurityEvent(audit, {
            eventType: "job_queued",
            severity: "info",
            ipAddress: requesterIp,
            actorType: "client",
            actorId: requestWithCallback.sourceClientId,
            resourceType: "job",
            resourceId: job.id,
            metadata: {
              reason: assignment.reason,
            },
          });
        }

        writeJson(
          response,
          isQueuedJobResponse(assignment) ? 202 : 201,
          assignment,
        );
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

      if (request.method === "POST" && url.pathname === "/storage/catalog/lookup") {
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isStorageCatalogLookupRequest(body)) {
          writeError(
            response,
            400,
            "invalid_storage_catalog_lookup",
            "Invalid storage catalog lookup payload",
          );
          return;
        }

        if (
          (body.requesterType === "client" &&
            !hasClientKey(request.headers["x-client-key"], config)) ||
          (body.requesterType === "worker" &&
            !hasWorkerServiceKey(request.headers["x-worker-service-key"], config))
        ) {
          writeError(
            response,
            401,
            "unauthorized_storage_catalog",
            "Invalid storage catalog key",
          );
          return;
        }

        const payload = await lookupStorageCatalog(storageNodes, config, {
          requesterId: body.requesterId,
          cacheKeys: body.cacheKeys,
          kinds: body.kinds,
        });

        recordSecurityEvent(audit, {
          eventType: "storage_catalog_lookup",
          severity: "info",
          ipAddress: requesterIp,
          actorType: body.requesterType,
          actorId: body.requesterId,
          resourceType: "storage",
          metadata: {
            cacheKeys: body.cacheKeys.length,
            kinds: body.kinds,
            locations: payload.locations.length,
          },
        });

        writeJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/storage/catalog/garments/categories") {
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isGarmentCatalogCategoriesRequest(body)) {
          writeError(
            response,
            400,
            "invalid_garment_catalog_categories",
            "Invalid garment catalog categories payload",
          );
          return;
        }

        if (
          (body.requesterType === "client" &&
            !hasClientKey(request.headers["x-client-key"], config)) ||
          (body.requesterType === "worker" &&
            !hasWorkerServiceKey(request.headers["x-worker-service-key"], config))
        ) {
          writeError(
            response,
            401,
            "unauthorized_garment_catalog",
            "Invalid garment catalog key",
          );
          return;
        }

        const payload = await listGarmentCatalogCategories(storageNodes, config);

        recordSecurityEvent(audit, {
          eventType: "garment_catalog_categories",
          severity: "info",
          ipAddress: requesterIp,
          actorType: body.requesterType,
          actorId: body.requesterId,
          resourceType: "storage",
          metadata: {
            categories: payload.categories.length,
          },
        });

        writeJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/storage/catalog/garments/search") {
        const body = await readJsonBody(request, {
          maxBytes: config.maxJsonBodyBytes,
        });

        if (!isGarmentCatalogSearchRequest(body)) {
          writeError(
            response,
            400,
            "invalid_garment_catalog_search",
            "Invalid garment catalog search payload",
          );
          return;
        }

        if (
          (body.requesterType === "client" &&
            !hasClientKey(request.headers["x-client-key"], config)) ||
          (body.requesterType === "worker" &&
            !hasWorkerServiceKey(request.headers["x-worker-service-key"], config))
        ) {
          writeError(
            response,
            401,
            "unauthorized_garment_catalog",
            "Invalid garment catalog key",
          );
          return;
        }

        const payload = await searchGarmentCatalog(storageNodes, config, {
          requesterId: body.requesterId,
          categories: body.categories,
          tags: body.tags,
          text: body.text,
          limit: body.limit,
        });

        recordSecurityEvent(audit, {
          eventType: "garment_catalog_search",
          severity: "info",
          ipAddress: requesterIp,
          actorType: body.requesterType,
          actorId: body.requesterId,
          resourceType: "storage",
          metadata: {
            categories: body.categories,
            tags: body.tags,
            items: payload.items.length,
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

        if (!hasClientKey(request.headers["x-client-key"], config)) {
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
          !hasStorageServiceKey(request.headers["x-storage-service-key"], config)
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
          !hasClientKey(request.headers["x-client-key"], config)
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
          !hasWorkerServiceKey(request.headers["x-worker-service-key"], config)
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

        const activeJobs = await jobs.findActiveByWorker(body.workerId);
        const worker = await workers.heartbeat({
          ...body,
          runningJobs: Math.max(body.runningJobs, activeJobs.length),
        });

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
          !hasWorkerServiceKey(request.headers["x-worker-service-key"], config)
        ) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const job = await jobs.markRunning(body);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        logger.info("Job progress received", {
          jobId: job.id,
          sourceClientId: job.sourceClientId,
          workerId: previous.assignedWorkerId,
          status: body.status,
          message: body.message,
        });
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
          !hasWorkerServiceKey(request.headers["x-worker-service-key"], config)
        ) {
          writeError(response, 401, "unauthorized_worker", "Invalid worker key");
          return;
        }

        const job = await jobs.markResult(body);

        if (!job) {
          writeError(response, 404, "job_not_found", "Job not found");
          return;
        }

        logger.info("Job result received", {
          jobId: job.id,
          sourceClientId: job.sourceClientId,
          workerId: previous.assignedWorkerId,
          status: body.status,
          errorCode: body.error?.code,
          retryable: body.error?.retryable,
          resultMessageLength: body.result?.message.length,
          resultFiles: body.result?.files?.length ?? 0,
        });
        if (
          previous?.assignedWorkerId &&
          previous.status !== "succeeded" &&
          previous.status !== "delivery_failed" &&
          previous.status !== "cancelled" &&
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
      logger.error("Unhandled coordinator request error", {
        method: request.method,
        path: url.pathname,
        error,
      });
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

interface ValidInputFilesStoragePrefix {
  valid: true;
  storageId?: string;
  keyPrefix?: string;
}

interface AssignJobDeps {
  job: TryOnJob;
  config: CoordinatorConfig;
  jobs: JobStore;
  workers: WorkerRegistryStore;
  storageNodes: StorageRegistryStore;
  audit: SecurityAuditStore;
  requesterIp: string;
  inputFilesStoragePrefix: ValidInputFilesStoragePrefix;
  queueWaitLogLevel?: "debug" | "warn";
}

async function assignJobIfPossible({
  job,
  config,
  jobs,
  workers,
  storageNodes,
  audit,
  requesterIp,
  inputFilesStoragePrefix,
  queueWaitLogLevel = "warn",
}: AssignJobDeps): Promise<TryOnJobCreateResponse> {
  const firstQueued = (await jobs.findQueued())[0];

  if (firstQueued?.id !== job.id) {
    logger.debug("Job assignment skipped: waiting for queue turn", {
      jobId: job.id,
      firstQueuedJobId: firstQueued?.id,
    });
    return createQueuedJobResponse(job, "waiting_for_turn", config);
  }

  const request = createTryOnJobRequestFromJob(job);
  const requiredCapabilities = resolveRequiredCapabilities(request);
  logger.info("Job assignment matching started", {
    jobId: job.id,
    sourceClientId: job.sourceClientId,
    provider: request.payload.model?.provider ?? "mock",
    task: request.payload.model?.task,
    requiredCapabilities,
  });
  const worker = await workers.findAvailable(
    config.workerHeartbeatTimeoutMs,
    requiredCapabilities,
  );

  if (!worker) {
    logger[queueWaitLogLevel]("Job assignment queued: no available worker", {
      jobId: job.id,
      requiredCapabilities,
    });
    return createQueuedJobResponse(job, "no_available_worker", config);
  }

  const reservedWorker = await workers.reserve(worker.workerId);

  if (!reservedWorker) {
    logger[queueWaitLogLevel]("Job assignment queued: worker became unavailable before reserve", {
      jobId: job.id,
      workerId: worker.workerId,
    });
    return createQueuedJobResponse(job, "worker_not_available", config);
  }

  logger.info("Worker reserved for job", {
    jobId: job.id,
    workerId: reservedWorker.workerId,
    workerBaseUrl: reservedWorker.baseUrl,
    runningJobs: reservedWorker.runningJobs,
    capacity: reservedWorker.capacity,
  });

  const dispatchTokenExpiresAt = new Date(
    Date.now() + config.workerDispatchTokenTtlMs,
  ).toISOString();
  const assignedJob = await jobs.markAssigned(
    job.id,
    reservedWorker.workerId,
    dispatchTokenExpiresAt,
  );

  if (!assignedJob) {
    await workers.release(reservedWorker.workerId);
    const current = await jobs.get(job.id);

    logger.warn("Job assignment queued: job was not queue head after reserve", {
      jobId: job.id,
      workerId: reservedWorker.workerId,
    });
    return createQueuedJobResponse(current ?? job, "job_not_queue_head", config);
  }

  const workerRequest = createWorkerJobRequest(assignedJob.id, request, config);
  const storageAccess = await createStorageAccessAssignment(
    storageNodes,
    config,
    resolveJobStorageAccessRequest(
      assignedJob.id,
      reservedWorker.workerId,
      inputFilesStoragePrefix.storageId,
      inputFilesStoragePrefix.keyPrefix,
    ),
  );

  if (!storageAccess) {
    await workers.release(reservedWorker.workerId);
    const requeued = await jobs.requeue(assignedJob.id);

    logger.warn("Job assignment queued: no available storage", {
      jobId: assignedJob.id,
      workerId: reservedWorker.workerId,
    });
    return createQueuedJobResponse(
      requeued ?? assignedJob,
      "no_available_storage",
      config,
    );
  }

  workerRequest.storage = storageAccess;
  logger.info("Storage access assigned for job", {
    jobId: assignedJob.id,
    workerId: reservedWorker.workerId,
    storageId: storageAccess.storageId,
    keyPrefix: storageAccess.keyPrefix,
    scope: storageAccess.scope,
  });
  const callbackTokenExpiresAt = new Date(
    Date.now() + config.clientCallbackTokenTtlMs,
  ).toISOString();
  const dispatchToken = createDispatchToken(
    {
      purpose: "worker-dispatch",
      keyVersion: config.workerDispatchSigningKeyVersion,
      jobId: assignedJob.id,
      workerId: reservedWorker.workerId,
      expiresAt: dispatchTokenExpiresAt,
    },
    config.workerDispatchSigningKey,
  );
  const callbackToken = createDispatchToken(
    {
      purpose: "client-callback",
      keyVersion: config.clientCallbackSigningKeyVersion,
      jobId: assignedJob.id,
      clientId: assignedJob.sourceClientId,
      expiresAt: callbackTokenExpiresAt,
    },
    config.clientCallbackSigningKey,
  );

  try {
    logger.info("Preparing worker assignment", {
      jobId: assignedJob.id,
      workerId: reservedWorker.workerId,
      workerBaseUrl: reservedWorker.baseUrl,
      requiredCapabilities,
      callbackUrl: request.callbackUrl,
    });
    const prepared = await prepareWorkerAssignment(
      reservedWorker,
      assignedJob.id,
      request,
      requiredCapabilities,
      dispatchTokenExpiresAt,
      callbackToken,
      callbackTokenExpiresAt,
      config,
    );

    if (!prepared.accepted) {
      throw new Error("Worker rejected assignment preparation");
    }
    logger.info("Worker assignment prepared", {
      jobId: assignedJob.id,
      workerId: reservedWorker.workerId,
      expiresAt: prepared.expiresAt,
    });
  } catch (error) {
    logger.error("Worker assignment prepare failed", {
      jobId: assignedJob.id,
      workerId: reservedWorker.workerId,
      error,
    });

    let cancelConfirmed = false;

    try {
      cancelConfirmed = isWorkerCancelSafeToRelease(
        await cancelWorkerAssignment(reservedWorker, assignedJob.id, config),
      );
    } catch (cancelError) {
      logger.error("Failed to cancel prepared worker assignment", {
        jobId: assignedJob.id,
        workerId: reservedWorker.workerId,
        error: cancelError,
      });
    }

    if (!cancelConfirmed) {
      await workers.markOffline(reservedWorker.workerId);
      await jobs.markFailed(assignedJob.id, {
        code: "worker_prepare_failed",
        message:
          error instanceof Error
            ? error.message
            : "Worker failed to prepare assignment",
        retryable: true,
      });
      throw new HttpRequestError(
        502,
        "worker_prepare_failed",
        "Worker failed to prepare assignment",
      );
    }

    await workers.release(reservedWorker.workerId);
    const requeued = await jobs.requeue(assignedJob.id);

    logger.info("Job requeued after worker prepare failure", {
      jobId: assignedJob.id,
      workerId: reservedWorker.workerId,
    });
    return createQueuedJobResponse(
      requeued ?? assignedJob,
      "worker_prepare_failed",
      config,
    );
  }

  const assignment: TryOnJobAssignmentResponse = {
    job: assignedJob,
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
    actorId: assignedJob.sourceClientId,
    resourceType: "job",
    resourceId: assignedJob.id,
    metadata: {
      workerId: reservedWorker.workerId,
      storageId: storageAccess.storageId,
    },
  });

  logger.info("Job assignment issued", {
    jobId: assignedJob.id,
    sourceClientId: assignedJob.sourceClientId,
    workerId: reservedWorker.workerId,
    workerBaseUrl: reservedWorker.baseUrl,
    storageId: storageAccess.storageId,
    provider: request.payload.model?.provider ?? "mock",
    task: request.payload.model?.task,
  });

  return assignment;
}

function createQueuedJobResponse(
  job: TryOnJob,
  reason: string,
  config: CoordinatorConfig,
): TryOnJobQueuedResponse {
  return {
    job,
    queued: true,
    retryAfterMs: Math.max(250, config.schedulerIntervalMs),
    reason,
  };
}

function isQueuedJobResponse(
  response: TryOnJobCreateResponse,
): response is TryOnJobQueuedResponse {
  return "queued" in response;
}

function createTryOnJobRequestFromJob(job: TryOnJob): CreateTryOnJobRequest {
  return {
    sourceClientId: job.sourceClientId,
    client: job.client,
    payload: job.payload,
    callbackUrl: job.callbackUrl,
  };
}

function isWorkerCancelSafeToRelease(
  cancellation: WorkerJobCancelResponse,
): boolean {
  return (
    cancellation.cancelledPending ||
    cancellation.cancelledRunning ||
    cancellation.runningCancellationSupported
  );
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
): Promise<WorkerJobCancelResponse> {
  return postJson<WorkerJobCancelResponse>(
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
    const provider = request.payload.model?.provider;
    const required = new Set<string>(
      provider ? ["try-on", `try-on.${provider}`] : ["try-on"],
    );

    if (request.payload.model?.task === "ideal-outfit") {
      required.add("try-on.openai");
      required.add("try-on.pruna");
    }

    return [...required];
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

async function lookupStorageCatalog(
  storageNodes: StorageRegistryStore,
  config: CoordinatorConfig,
  request: {
    requesterId: string;
    cacheKeys: string[];
    kinds?: Array<StorageCatalogLocation["entry"]["kind"]>;
  },
): Promise<StorageCatalogLookupResponse> {
  const nodes = await findAvailableStorageNodes(
    storageNodes,
    config.storageHeartbeatTimeoutMs,
  );
  const settled = await Promise.allSettled(
    nodes.map(async (node) => {
      const response = await postJson<StorageCatalogNodeLookupResponse>(
        `${node.baseUrl}/catalog/lookup`,
        {
          cacheKeys: request.cacheKeys,
          kinds: request.kinds,
        },
        {
          "x-storage-service-key": config.storageServiceKey,
        },
        {
          retries: config.httpClientRetries,
          timeoutMs: config.httpClientTimeoutMs,
        },
      );

      return {
        node,
        entries: Array.isArray(response.entries)
          ? response.entries.filter(isStorageCatalogEntry)
          : [],
      };
    }),
  );
  const locations: StorageCatalogLocation[] = [];

  for (const result of settled) {
    if (result.status === "rejected") {
      logger.warn("Storage catalog lookup failed on node", {
        error: result.reason,
      });
      continue;
    }

    for (const entry of result.value.entries) {
      const objectKey = normalizeStorageKey(entry.object.key);
      const keyPrefix = dirnameStorageKey(objectKey) ?? objectKey;
      const storage = createStorageAccessForNode(result.value.node, config, {
        requesterId: request.requesterId,
        scope: "read",
        keyPrefix,
      });

      locations.push({
        storageId: result.value.node.storageId,
        baseUrl: result.value.node.baseUrl,
        entry,
        storage,
        objectUrl: storageObjectAccessUrl(
          storage.objectBaseUrl,
          objectKey,
          storage.accessToken,
        ),
      });
    }
  }

  return { locations };
}

async function listGarmentCatalogCategories(
  storageNodes: StorageRegistryStore,
  config: CoordinatorConfig,
): Promise<GarmentCatalogCategoriesResponse> {
  const nodes = await findAvailableStorageNodes(
    storageNodes,
    config.storageHeartbeatTimeoutMs,
  );
  const settled = await Promise.allSettled(
    nodes.map((node) =>
      postJson<GarmentCatalogCategoriesResponse>(
        `${node.baseUrl}/catalog/garments/categories`,
        {},
        {
          "x-storage-service-key": config.storageServiceKey,
        },
        {
          retries: config.httpClientRetries,
          timeoutMs: config.httpClientTimeoutMs,
        },
      ),
    ),
  );
  const counts = new Map<string, number>();

  for (const result of settled) {
    if (result.status === "rejected") {
      logger.warn("Garment catalog categories failed on node", {
        error: result.reason,
      });
      continue;
    }

    for (const category of result.value.categories ?? []) {
      if (!category.name || category.count <= 0) {
        continue;
      }

      counts.set(category.name, (counts.get(category.name) ?? 0) + category.count);
    }
  }

  return {
    categories: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function searchGarmentCatalog(
  storageNodes: StorageRegistryStore,
  config: CoordinatorConfig,
  request: {
    requesterId: string;
    categories?: string[];
    tags?: string[];
    text?: string;
    limit?: number;
  },
): Promise<GarmentCatalogSearchResponse> {
  const nodes = await findAvailableStorageNodes(
    storageNodes,
    config.storageHeartbeatTimeoutMs,
  );
  const perNodeLimit = normalizeGarmentSearchLimit(request.limit);
  const settled = await Promise.allSettled(
    nodes.map(async (node) => {
      const response = await postJson<GarmentCatalogSearchResponse>(
        `${node.baseUrl}/catalog/garments/search`,
        {
          categories: request.categories,
          tags: request.tags,
          text: request.text,
          limit: perNodeLimit,
        },
        {
          "x-storage-service-key": config.storageServiceKey,
        },
        {
          retries: config.httpClientRetries,
          timeoutMs: config.httpClientTimeoutMs,
        },
      );

      return {
        node,
        items: Array.isArray(response.items)
          ? response.items.filter(isGarmentCatalogItem)
          : [],
      };
    }),
  );
  const deduped = new Map<string, GarmentCatalogItem>();

  for (const result of settled) {
    if (result.status === "rejected") {
      logger.warn("Garment catalog search failed on node", {
        error: result.reason,
      });
      continue;
    }

    for (const item of result.value.items) {
      const withAccess = attachGarmentAccess(
        item,
        result.value.node,
        config,
        request.requesterId,
      );
      const dedupeKey =
        withAccess.productUrl ?? `${withAccess.storageId}:${withAccess.cacheKey}`;

      if (!deduped.has(dedupeKey)) {
        deduped.set(dedupeKey, withAccess);
      }
    }
  }

  return {
    items: [...deduped.values()].slice(0, perNodeLimit),
  };
}

function attachGarmentAccess(
  item: GarmentCatalogItem,
  node: RegisteredStorageNode,
  config: CoordinatorConfig,
  requesterId: string,
): GarmentCatalogItem {
  const objectKey = normalizeStorageKey(item.image.key);
  const keyPrefix = dirnameStorageKey(objectKey) ?? objectKey;
  const storage = createStorageAccessForNode(node, config, {
    requesterId,
    scope: "read",
    keyPrefix,
  });

  return {
    ...item,
    storageId: node.storageId,
    image: {
      ...item.image,
      storageId: node.storageId,
    },
    imageUrl: storageObjectAccessUrl(
      storage.objectBaseUrl,
      objectKey,
      storage.accessToken,
    ),
  };
}

function normalizeGarmentSearchLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(1, Math.min(100, Math.floor(value)));
}

async function findAvailableStorageNodes(
  storageNodes: StorageRegistryStore,
  heartbeatTimeoutMs: number,
): Promise<RegisteredStorageNode[]> {
  const now = Date.now();

  return (await storageNodes.list()).filter((node) => {
    const lastHeartbeatAt = new Date(node.lastHeartbeatAt).getTime();
    const isFresh = now - lastHeartbeatAt <= heartbeatTimeoutMs;
    const hasSpace =
      node.capacityBytes === undefined ||
      node.usedBytes === undefined ||
      node.usedBytes < node.capacityBytes;

    return isFresh && node.status !== "offline" && hasSpace;
  });
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

function storageObjectAccessUrl(
  objectBaseUrl: string,
  key: string,
  accessToken: string,
): string {
  const url = new URL(`${objectBaseUrl.replace(/\/$/, "")}/${encodeStorageKey(key)}`);
  url.searchParams.set("accessToken", accessToken);

  return url.toString();
}

function encodeStorageKey(key: string): string {
  return key
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
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
