import type {
  JobProgressUpdateRequest,
  JobResultUpdateRequest,
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
