export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.buckets.set(key, {
        count: 1,
        resetAt,
      });

      return {
        allowed: true,
        remaining: Math.max(0, this.maxRequests - 1),
        resetAt,
      };
    }

    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: bucket.resetAt,
      };
    }

    bucket.count += 1;

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  cleanup(): void {
    const now = Date.now();

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
