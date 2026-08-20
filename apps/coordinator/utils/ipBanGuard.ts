export interface IpBanRecord {
  ipAddress: string;
  failedAttempts: number;
  lastFailedAt: string;
  banned: boolean;
  bannedAt?: string;
}

export class IpBanGuard {
  private readonly records = new Map<string, IpBanRecord>();

  constructor(
    private readonly maxInvalidAttempts: number,
    bannedIpAddresses: string[] = [],
  ) {
    const now = new Date().toISOString();

    for (const ipAddress of bannedIpAddresses) {
      this.records.set(ipAddress, {
        ipAddress,
        failedAttempts: maxInvalidAttempts,
        lastFailedAt: now,
        banned: true,
        bannedAt: now,
      });
    }
  }

  isBanned(ipAddress: string): boolean {
    return this.records.get(ipAddress)?.banned ?? false;
  }

  registerFailure(ipAddress: string): IpBanRecord {
    const previous = this.records.get(ipAddress);
    const now = new Date().toISOString();
    const failedAttempts = (previous?.failedAttempts ?? 0) + 1;
    const banned = previous?.banned || failedAttempts >= this.maxInvalidAttempts;
    const record: IpBanRecord = {
      ipAddress,
      failedAttempts,
      lastFailedAt: now,
      banned,
      bannedAt: banned ? previous?.bannedAt ?? now : undefined,
    };

    this.records.set(ipAddress, record);

    return record;
  }

  clear(ipAddress: string): void {
    this.records.delete(ipAddress);
  }

  listBanned(): IpBanRecord[] {
    return [...this.records.values()].filter((record) => record.banned);
  }
}
