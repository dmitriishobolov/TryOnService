import type {
  StorageHeartbeatRequest,
  StorageRegistrationRequest,
  StorageRegistrationResponse,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import type { StorageConfig } from "../config/index.js";

export class StorageCoordinatorClient {
  constructor(private readonly config: StorageConfig) {}

  register(): Promise<StorageRegistrationResponse> {
    const payload: StorageRegistrationRequest = {
      storageId: this.config.storageId,
      port: this.config.port,
      publicProtocol: this.config.publicProtocol,
      publicUrl: this.config.publicUrl,
      driver: this.config.driver,
      capacityBytes: this.config.capacityBytes,
    };

    return postJson<StorageRegistrationResponse>(
      `${this.config.coordinatorUrl}/storage/register`,
      payload,
      this.registrationHeaders(),
      this.postOptions(),
    );
  }

  heartbeat(usedBytes?: number): Promise<unknown> {
    const payload: StorageHeartbeatRequest = {
      storageId: this.config.storageId,
      status: "ready",
      usedBytes,
      capacityBytes: this.config.capacityBytes,
    };

    return postJson(
      `${this.config.coordinatorUrl}/storage/${this.config.storageId}/heartbeat`,
      payload,
      this.serviceHeaders(),
      this.postOptions(),
    );
  }

  private registrationHeaders(): Record<string, string> {
    return {
      "x-storage-registration-key": this.config.registrationKey,
    };
  }

  private serviceHeaders(): Record<string, string> {
    return {
      "x-storage-service-key": this.config.serviceKey,
    };
  }

  private postOptions(): { retries: number; timeoutMs: number } {
    return {
      retries: this.config.httpClientRetries,
      timeoutMs: this.config.httpClientTimeoutMs,
    };
  }
}
