export type LimitResult = { allowed: boolean; limit: number; remaining: number; resetSeconds: number };

type Options = { limit: number; windowMs: number; maxKeys?: number; now?: () => number };

// Fixed-window counter per key. In memory: counters are per process and reset on restart, so with N replicas the
// effective limit is up to N x limit. limit <= 0 disables it. The clock is injectable for tests.
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor({ limit, windowMs, maxKeys = 50_000, now = Date.now }: Options) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  get enabled() {
    return this.limit > 0;
  }

  hit(key: string): LimitResult {
    if (!this.enabled) return { allowed: true, limit: 0, remaining: 0, resetSeconds: 0 };
    const now = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.hits.size >= this.maxKeys) this.makeRoom();
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  cleanup() {
    const now = this.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }

  get size() {
    return this.hits.size;
  }

  // Drop expired keys; if still full, evict the oldest-inserted one so memory stays bounded.
  private makeRoom() {
    this.cleanup();
    if (this.hits.size < this.maxKeys) return;
    const oldest = this.hits.keys().next();
    if (!oldest.done) this.hits.delete(oldest.value);
  }
}
