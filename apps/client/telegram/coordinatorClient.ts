import type {
  ClientHeartbeatRequest,
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  CreateTryOnJobRequest,
  TryOnJob,
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
    );
  }

  createRequestJob(params: {
    chatId: string;
    username?: string;
    text?: string;
  }): Promise<TryOnJob> {
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

    return postJson<TryOnJob>(`${this.config.coordinatorUrl}/jobs`, payload);
  }

  private headers(): Record<string, string> {
    return {
      "x-client-key": this.config.registrationKey,
    };
  }
}
