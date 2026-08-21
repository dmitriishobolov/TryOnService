import type {
  ClientHeartbeatRequest,
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  CreateTryOnJobRequest,
  JobCancelResponse,
  MarketSearchSelection,
  StorageAccessResponse,
  StorageCatalogEntryKind,
  StorageCatalogLookupResponse,
  StorageObjectRef,
  TryOnJobCreateResponse,
  TryOnModelSelection,
} from "../../shared/contracts/index.js";
import { getJson, postJson } from "../../shared/http.js";
import type { TelegramClientConfig } from "./config.js";

export class TelegramCoordinatorClient {
  constructor(private readonly config: TelegramClientConfig) {}

  register(): Promise<ClientRegistrationResponse> {
    const payload: ClientRegistrationRequest = {
      clientId: this.config.clientId,
      type: "telegram",
      port: this.config.port,
      publicProtocol: this.config.publicProtocol,
      publicUrl: this.config.publicUrl,
      callbackPath: "/callbacks/jobs",
    };

    return postJson<ClientRegistrationResponse>(
      `${this.config.coordinatorUrl}/clients/register`,
      payload,
      this.headers(),
      this.postOptions(),
    );
  }

  heartbeat(): Promise<unknown> {
    const payload: ClientHeartbeatRequest = {
      clientId: this.config.clientId,
      status: "ready",
    };

    return postJson(
      `${this.config.coordinatorUrl}/clients/${this.config.clientId}/heartbeat`,
      payload,
      this.headers(),
      this.postOptions(),
    );
  }

  createRequestJob(params: {
    chatId: string;
    username?: string;
    text?: string;
    model?: TryOnModelSelection;
    market?: MarketSearchSelection;
    inputFiles?: StorageObjectRef[];
  }): Promise<TryOnJobCreateResponse> {
    const payload: CreateTryOnJobRequest = {
      sourceClientId: this.config.clientId,
      client: {
        type: "telegram",
        chatId: params.chatId,
        username: params.username,
      },
      payload: {
        command: "request",
        text: params.text,
        model: params.model,
        market: params.market,
        inputFiles: params.inputFiles,
      },
    };

    return postJson<TryOnJobCreateResponse>(
      `${this.config.coordinatorUrl}/jobs`,
      payload,
      this.headers(),
      this.postOptions(),
    );
  }

  getJobAssignment(jobId: string): Promise<TryOnJobCreateResponse> {
    const url = new URL(
      `${this.config.coordinatorUrl}/jobs/${encodeURIComponent(jobId)}/assignment`,
    );
    url.searchParams.set("sourceClientId", this.config.clientId);

    return getJson<TryOnJobCreateResponse>(
      url.toString(),
      this.headers(),
      this.postOptions(),
    );
  }

  cancelQueuedJob(jobId: string, reason: string): Promise<JobCancelResponse> {
    return postJson<JobCancelResponse>(
      `${this.config.coordinatorUrl}/jobs/${encodeURIComponent(jobId)}/cancel`,
      {
        sourceClientId: this.config.clientId,
        reason,
      },
      this.headers(),
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
        requesterId: this.config.clientId,
        requesterType: "client",
        scope: params.scope,
        storageId: params.storageId,
        keyPrefix: params.keyPrefix,
      },
      this.headers(),
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
        requesterId: this.config.clientId,
        requesterType: "client",
        cacheKeys: params.cacheKeys,
        kinds: params.kinds,
      },
      this.headers(),
      this.postOptions(),
    );
  }

  private headers(): Record<string, string> {
    return {
      "x-client-key": this.config.registrationKey,
    };
  }

  private postOptions(): { retries: number; timeoutMs: number } {
    return {
      retries: this.config.httpClientRetries,
      timeoutMs: this.config.httpClientTimeoutMs,
    };
  }
}
