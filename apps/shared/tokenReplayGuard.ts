export class TokenReplayGuard {
  private readonly seen = new Map<string, number>();

  hasSeen(tokenId: string): boolean {
    this.cleanup();

    return this.seen.has(tokenId);
  }

  remember(tokenId: string, expiresAt: string): void {
    this.cleanup();
    this.seen.set(tokenId, new Date(expiresAt).getTime());
  }

  private cleanup(): void {
    const now = Date.now();

    for (const [tokenId, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(tokenId);
      }
    }
  }
}
