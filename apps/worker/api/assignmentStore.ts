import type {
  WorkerAssignmentPrepareRequest,
} from "../../shared/contracts/index.js";

export interface PreparedAssignment {
  jobId: string;
  workerId: string;
  sourceClientId: string;
  clientChatId: string;
  callbackUrl?: string;
  requiredCapabilities: string[];
  dispatchTokenExpiresAt: string;
  callbackToken?: string;
  callbackTokenExpiresAt?: string;
  preparedAt: string;
}

export class WorkerAssignmentStore {
  private readonly assignments = new Map<string, PreparedAssignment>();

  prepare(request: WorkerAssignmentPrepareRequest): PreparedAssignment {
    const assignment: PreparedAssignment = {
      jobId: request.jobId,
      workerId: request.workerId,
      sourceClientId: request.sourceClientId,
      clientChatId: request.client.chatId,
      callbackUrl: request.callbackUrl,
      requiredCapabilities: request.requiredCapabilities,
      dispatchTokenExpiresAt: request.dispatchTokenExpiresAt,
      callbackToken: request.callbackToken,
      callbackTokenExpiresAt: request.callbackTokenExpiresAt,
      preparedAt: new Date().toISOString(),
    };

    this.assignments.set(assignment.jobId, assignment);

    return assignment;
  }

  get(jobId: string): PreparedAssignment | undefined {
    return this.assignments.get(jobId);
  }

  consume(jobId: string): PreparedAssignment | undefined {
    const assignment = this.assignments.get(jobId);

    if (!assignment) {
      return undefined;
    }

    this.assignments.delete(jobId);

    return assignment;
  }

  cancel(jobId: string): PreparedAssignment | undefined {
    return this.consume(jobId);
  }

  countPending(): number {
    return this.assignments.size;
  }

  cleanupExpired(): PreparedAssignment[] {
    const now = Date.now();
    const expired: PreparedAssignment[] = [];

    for (const assignment of this.assignments.values()) {
      if (new Date(assignment.dispatchTokenExpiresAt).getTime() <= now) {
        this.assignments.delete(assignment.jobId);
        expired.push(assignment);
      }
    }

    return expired;
  }
}
