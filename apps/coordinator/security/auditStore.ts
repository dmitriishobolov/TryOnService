export type SecurityAuditSeverity = "info" | "warning" | "critical";

export interface SecurityAuditEvent {
  eventType: string;
  severity: SecurityAuditSeverity;
  ipAddress?: string;
  actorType?: "client" | "worker" | "storage" | "admin" | "unknown";
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface SecurityAuditStore {
  record(event: SecurityAuditEvent): Promise<void>;
  list(limit?: number): Promise<SecurityAuditEvent[]>;
}

export class InMemorySecurityAuditStore implements SecurityAuditStore {
  private readonly events: SecurityAuditEvent[] = [];

  async record(event: SecurityAuditEvent): Promise<void> {
    this.events.push({
      ...event,
      createdAt: event.createdAt ?? new Date().toISOString(),
    });

    if (this.events.length > 1_000) {
      this.events.splice(0, this.events.length - 1_000);
    }
  }

  async list(limit = 100): Promise<SecurityAuditEvent[]> {
    return this.events.slice(-limit).reverse();
  }
}
