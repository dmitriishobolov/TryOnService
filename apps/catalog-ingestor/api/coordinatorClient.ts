import type {
  ClientHeartbeatRequest,
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  StorageAccessResponse,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import type { CatalogIngestorConfig } from "../config/index.js";

export class CatalogCoordinatorClient {
  constructor(private readonly config: CatalogIngestorConfig) {}

  register(): Promise<ClientRegistrationResponse> {
    const payload: ClientRegistrationRequest = {
      clientId: this.config.clientId,
      type: "catalog-ingestor",
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