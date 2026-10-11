/* Per-key token-bucket rate limiter (zero deps). `rps` tokens refill per second
 * up to `burst`; each allowed request spends one. The key map is bounded
 * (oldest evicted) so a flood of distinct IPs can't grow memory unboundedly. */
interface Bucket { tokens: number; last: number }

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly maxKeys = 4096,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      b = { tokens: this.burst, last: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.last) / 1000) * this.rps);
    b.last = t;
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    return false;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null, oldestT = Infinity;
    for (const [k, v] of this.buckets) if (v.last < oldestT) { oldestT = v.last; oldestKey = k; }
    if (oldestKey != null) this.buckets.delete(oldestKey);
  }

  get size(): number { return this.buckets.size; }
}
