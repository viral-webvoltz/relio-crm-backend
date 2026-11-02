import { describe, expect, it, vi } from 'vitest';
import { AuthLimiter, type CounterStore } from './auth-limiter.js';

// A shared store that several limiter instances can use at once, like the Postgres table: counts per key per fixed window.
function fakeStore(clock: { now: number }, windowSeconds = 60) {
  const counts = new Map<string, number>();
  const calls: string[][] = [];
  const store: CounterStore = {
    async hit(keys) {
      calls.push(keys);
      const windowStart = Math.floor(clock.now / 1000 / windowSeconds);
      return keys.map((key) => {
        const id = `${key}@${windowStart}`;
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        return { key, count, resetSeconds: (windowStart + 1) * windowSeconds - clock.now / 1000 };
      });
    },
  };
  return { store, calls };
}

const setup = (userLimit: number, orgLimit: number, extra: Partial<ConstructorParameters<typeof AuthLimiter>[0]> = {}) => {
  const clock = { now: 1_000_000_000_000 };
  const { store, calls } = fakeStore(clock);
  const limiter = new AuthLimiter({ userLimit, orgLimit, store, now: () => clock.now, ...extra });
  return { clock, store, calls, limiter };
};

describe('AuthLimiter with a shared store', () => {
  it('allows requests under the limit and reports the tightest remaining count', async () => {
    const { limiter } = setup(3, 100);
    expect(await limiter.check('u1', 'o1')).toMatchObject({ blocked: false, limit: 3, remaining: 2 });
    expect(await limiter.check('u1', 'o1')).toMatchObject({ blocked: false, remaining: 1 });
  });

  it('blocks the user once their limit is exceeded, with a retry time inside the window', async () => {
    const { limiter } = setup(2, 100);
    await limiter.check('u1', 'o1');
    await limiter.check('u1', 'o1');
    const third = await limiter.check('u1', 'o1');
    expect(third).toMatchObject({ blocked: true, remaining: 0 });
    expect(third?.resetSeconds).toBeGreaterThanOrEqual(1);
    expect(third?.resetSeconds).toBeLessThanOrEqual(60);
  });

  it('limits an organization across all of its users', async () => {
    const { limiter } = setup(100, 3);
    await limiter.check('u1', 'o1');
    await limiter.check('u2', 'o1');
    await limiter.check('u3', 'o1');
    expect((await limiter.check('u4', 'o1'))?.blocked).toBe(true);
    expect((await limiter.check('u4', 'o2'))?.blocked).toBe(false);
  });

  it('shares the count between instances: two limiters on one store add up', async () => {
    const clock = { now: 1_000_000_000_000 };
    const { store } = fakeStore(clock);
    const a = new AuthLimiter({ userLimit: 4, orgLimit: 0, store, now: () => clock.now });
    const b = new AuthLimiter({ userLimit: 4, orgLimit: 0, store, now: () => clock.now });
    await a.check('u1', 'o1');
    await b.check('u1', 'o1');
    await a.check('u1', 'o1');
    await b.check('u1', 'o1');
    expect((await a.check('u1', 'o1'))?.blocked).toBe(true); // a per-process limiter would still have allowed this
  });

  it('rejects an already-blocked client from memory without touching the store', async () => {
    const { limiter, calls } = setup(1, 100);
    await limiter.check('u1', 'o1');
    await limiter.check('u1', 'o1'); // over the limit: remembered
    const before = calls.length;
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(true);
    expect(calls.length).toBe(before);
  });

  it('lets the client back in when the window rolls over', async () => {
    const { limiter, clock } = setup(1, 100);
    await limiter.check('u1', 'o1');
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(true);
    clock.now += 61_000;
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(false);
  });

  it('sends only the enabled keys to the store, and nothing when both limits are 0', async () => {
    const onlyOrg = setup(0, 5);
    await onlyOrg.limiter.check('u1', 'o1');
    expect(onlyOrg.calls[0]).toEqual(['o:o1']);

    const off = setup(0, 0);
    expect(await off.limiter.check('u1', 'o1')).toBeNull();
    expect(off.calls).toHaveLength(0);
  });
});

describe('AuthLimiter when the store fails', () => {
  const failing: CounterStore = { hit: () => Promise.reject(new Error('db down')) };

  it('fails open to local counting, still enforcing the limit, and reports the error', async () => {
    const onStoreError = vi.fn();
    const limiter = new AuthLimiter({ userLimit: 2, orgLimit: 100, store: failing, onStoreError });
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(false);
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(false);
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(true);
    expect(onStoreError).toHaveBeenCalled();
  });

  it('counts locally when no store is configured at all', async () => {
    const limiter = new AuthLimiter({ userLimit: 1, orgLimit: 0 });
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(false);
    expect((await limiter.check('u1', 'o1'))?.blocked).toBe(true);
  });
});
