export type RegistrationBanScope = "client" | "worker" | "storage";

export interface RegistrationBanRecord {
  scope: RegistrationBanScope;
  ipAddress: string;
  bannedAt: string;
}

export interface RegistrationBanStore {
  ban(record: RegistrationBanRecord): Promise<void>;
  list(scope: RegistrationBanScope): Promise<RegistrationBanRecord[]>;
}

export class InMemoryRegistrationBanStore implements RegistrationBanStore {
  private readonly records = new Map<string, RegistrationBanRecord>();

  async ban(record: RegistrationBanRecord): Promise<void> {
    this.records.set(this.key(record.scope, record.ipAddress), record);
  }

  async list(scope: RegistrationBanScope): Promise<RegistrationBanRecord[]> {
    return [...this.records.values()].filter((record) => record.scope === scope);
  }

  private key(scope: RegistrationBanScope, ipAddress: string): string {
    return `${scope}:${ipAddress}`;
  }
}
