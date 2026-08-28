import type {
  GarmentCatalogCategoriesResponse,
  GarmentCatalogSearchResponse,
  JobProgressUpdateRequest,
  JobResultUpdateRequest,
  StorageAccessResponse,
  StorageCatalogEntryKind,
  StorageCatalogLookupResponse,
  WorkerHeartbeatRequest,
  WorkerRegistrationRequest,
  WorkerRegistrationResponse,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import type { WorkerConfig } from "../config/index.js";

export class CoordinatorClient {
  constructor(private readonly config: WorkerConfig) {}

  register(): Promise<WorkerRegistrationResponse> {
    const payload: WorkerRegistrationRequest = {
      workerId: this.config.workerId,
      port: this.config.port,
      publicProtocol: this.config.publicProtocol,
      publicUrl: this.config.publicUrl,
      capacity: this.config.capacity,
      capabilities: this.config.capabilities,
    };

    return postJson<WorkerRegistrationResponse>(
      `${this.config.coordinatorUrl}/workers/register`,
      payload,
      this.registrationHeaders(),
      this.postOptions(),
    );
  }

  heartbeat(runningJobs: number): Promise<unknown> {
    const payload: WorkerHeartbeatRequest = {
      workerId: this.config.workerId,
      status: runningJobs >= this.config.capacity ? "busy" : "ready",
      runningJobs,
      capacity: this.config.capacity,
    };

    return postJson(
      `${this.config.coordinatorUrl}/workers/${this.config.workerId}/heartbeat`,
      payload,
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  reportProgress(update: JobProgressUpdateRequest): Promise<unknown> {
    return postJson(
      updateUrl(update.jobId, "progress", this.config),
      update,
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  reportResult(update: JobResultUpdateRequest): Promise<unknown> {
    return postJson(
      updateUrl(update.jobId, "result", this.config),
      update,
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  requestStorageAccess(params: {
    scope: "read" | "write" | "read-write";
    storageId?: string;
    keyPrefix?: string;
  }): Promise<StorageAccessResponse> {
    return postJson<StorageAccessResponse>(
      `${this.config.coordinatorUrl}/storage/access`,
      {
        requesterId: this.config.workerId,
        requesterType: "worker",
        scope: params.scope,
        storageId: params.storageId,
        keyPrefix: params.keyPrefix,
      },
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  lookupStorageCatalog(params: {
    cacheKeys: string[];
    kinds?: StorageCatalogEntryKind[];
  }): Promise<StorageCatalogLookupResponse> {
    return postJson<StorageCatalogLookupResponse>(
      `${this.config.coordinatorUrl}/storage/catalog/lookup`,
      {
        requesterId: this.config.workerId,
        requesterType: "worker",
        cacheKeys: params.cacheKeys,
        kinds: params.kinds,
      },
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  listGarmentCatalogCategories(): Promise<GarmentCatalogCategoriesResponse> {
    return postJson<GarmentCatalogCategoriesResponse>(
      `${this.config.coordinatorUrl}/storage/catalog/garments/categories`,
      {
        requesterId: this.config.workerId,
        requesterType: "worker",
      },
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  searchGarmentCatalog(params: {
    categories?: string[];
    tags?: string[];
    text?: string;
    limit?: number;
  }): Promise<GarmentCatalogSearchResponse> {
    return postJson<GarmentCatalogSearchResponse>(
      `${this.config.coordinatorUrl}/storage/catalog/garments/search`,
      {
        requesterId: this.config.workerId,
        requesterType: "worker",
        categories: params.categories,
        tags: params.tags,
        text: params.text,
        limit: params.limit,
      },
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  registrationHeaders(): Record<string, string> {
    return {
      "x-worker-registration-key": this.config.registrationKey,
    };
  }

  serviceHeaders(): Record<string, string> {
    return {
      "x-worker-service-key": this.config.serviceKey,
    };
  }

  postOptions(): { retries: number; timeoutMs: number } {
    return {
      retries: this.config.httpClientRetries,
      timeoutMs: this.config.httpClientTimeoutMs,
    };
  }
}

function updateUrl(
  jobId: string,
  kind: "progress" | "result",
  config: WorkerConfig,
): string {
  return `${config.coordinatorUrl}/jobs/${jobId}/${kind}`;
}
