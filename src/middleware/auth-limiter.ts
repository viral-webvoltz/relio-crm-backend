import { WindowLimiter, type LimitResult } from './window-limiter.js';

export type CounterHit = { key: string; count: number; resetSeconds: number };

// A shared counter store: increments every key by one in the current window and returns the new counts.
export interface CounterStore {
  hit(keys: string[], windowSeconds: number): Promise<CounterHit[]>;
}

export type Decision = { limit: number; remaining: number; resetSeconds: number; blocked: boolean };

type Options = {
  userLimit: number;
  orgLimit: number;
  windowSeconds?: number;
  /** Shared store (Postgres). Without one, or when it fails, counting falls back to per-process memory. */
  store?: CounterStore;
  now?: () => number;
  onStoreError?: (err: unknown) => void;
};

const MAX_BLOCKED = 10_000;

// Per-user and per-organization request limits for authenticated traffic. limit <= 0 disables that dimension.
// With a store the counts are shared by every instance; a store failure fails OPEN to local counting (an outage of the counter
// table must not take the API down). Clients already over the limit are rejected from memory until their window ends,
// so a flood of blocked requests does not hit the database.
export class AuthLimiter {
  private readonly blockedUntil = new Map<string, number>();
  private readonly localUser: WindowLimiter;
  private readonly localOrg: WindowLimiter;
  private readonly windowSeconds: number;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.windowSeconds = options.windowSeconds ?? 60;
    this.now = options.now ?? Date.now;
    const windowMs = this.windowSeconds * 1000;
    this.localUser = new WindowLimiter({ limit: options.userLimit, windowMs, now: this.now });
    this.localOrg = new WindowLimiter({ limit: options.orgLimit, windowMs, now: this.now });
  }

  async check(userId: string, organizationId: string): Promise<Decision | null> {
    const { userLimit, orgLimit, store } = this.options;
    const targets = [
      ...(userLimit > 0 ? [{ key: `u:${userId}`, limit: userLimit }] : []),
      ...(orgLimit > 0 ? [{ key: `o:${organizationId}`, limit: orgLimit }] : []),
    ];
    if (targets.length === 0) return null;

    const now = this.now();
    for (const { key, limit } of targets) {
      const until = this.blockedUntil.get(key);
      if (until !== undefined && until > now) return { limit, remaining: 0, resetSeconds: Math.max(1, Math.ceil((until - now) / 1000)), blocked: true };
    }

    let hits: CounterHit[] | null = null;
    if (store) {
      try {
        hits = await store.hit(
          targets.map((t) => t.key),
          this.windowSeconds,
        );
      } catch (err) {
        this.options.onStoreError?.(err);
      }
    }

    const results: (LimitResult & { key: string })[] = hits
      ? targets.map(({ key, limit }) => {
          const hit = hits.find((h) => h.key === key);
          const count = hit?.count ?? 1;
          return {
            key,
            allowed: count <= limit,
            limit,
            remaining: Math.max(0, limit - count),
            resetSeconds: Math.max(1, Math.ceil(hit?.resetSeconds ?? this.windowSeconds)),
          };
        })
      : targets.map(({ key }) => ({ key, ...(key.startsWith('u:') ? this.localUser : this.localOrg).hit(key) }));

    const blocked = results.find((r) => !r.allowed);
    if (blocked) this.remember(blocked.key, now + blocked.resetSeconds * 1000);

    const tightest = results.reduce((a, r) => (r.remaining < a.remaining ? r : a));
    return { limit: tightest.limit, remaining: tightest.remaining, resetSeconds: (blocked ?? tightest).resetSeconds, blocked: Boolean(blocked) };
  }

  private remember(key: string, until: number) {
    if (this.blockedUntil.size >= MAX_BLOCKED) {
      const now = this.now();
      for (const [k, t] of this.blockedUntil) if (t <= now) this.blockedUntil.delete(k);
      if (this.blockedUntil.size >= MAX_BLOCKED) return; // still full of live blocks: skip the cache, the store stays the source of truth
    }
    this.blockedUntil.set(key, until);
  }
}
