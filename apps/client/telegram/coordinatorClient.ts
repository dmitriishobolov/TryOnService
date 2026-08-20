import type {
  ClientHeartbeatRequest,
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  CreateTryOnJobRequest,
  StorageAccessResponse,
  TryOnJobAssignmentResponse,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
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
  }): Promise<TryOnJobAssignmentResponse> {
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
      },
    };

    return postJson<TryOnJobAssignmentResponse>(
      `${this.config.coordinatorUrl}/jobs`,
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
