import type {
  CreateTryOnJobRequest,
  TryOnJob,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import type { TelegramClientConfig } from "./config.js";

export class TelegramCoordinatorClient {
  constructor(private readonly config: TelegramClientConfig) {}

  createRequestJob(params: {
    chatId: string;
    username?: string;
    text?: string;
  }): Promise<TryOnJob> {
    const payload: CreateTryOnJobRequest = {
      client: {
        type: "telegram",
        chatId: params.chatId,
        username: params.username,
      },
      payload: {
        command: "request",
        text: params.text,
      },
      callbackUrl: `${this.config.publicUrl}/callbacks/jobs`,
    };

    return postJson<TryOnJob>(`${this.config.coordinatorUrl}/jobs`, payload);
  }
}
