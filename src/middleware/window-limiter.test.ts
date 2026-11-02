import { describe, expect, it } from 'vitest';
import { WindowLimiter } from './window-limiter.js';

const setup = (limit: number, maxKeys?: number) => {
  let t = 1_000;
  const limiter = new WindowLimiter({ limit, windowMs: 60_000, maxKeys, now: () => t });
  return { limiter, advance: (ms: number) => (t += ms) };
};

describe('WindowLimiter', () => {
  it('blocks after the limit and rolls over with the window', () => {
    const { limiter, advance } = setup(2);
    expect(limiter.hit('a').allowed).toBe(true);
    const second = limiter.hit('a');
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = limiter.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetSeconds).toBe(60);
    advance(60_000);
    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('counts keys separately', () => {
    const { limiter } = setup(1);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('cleanup drops expired keys', () => {
    const { limiter, advance } = setup(5);
    limiter.hit('a');
    advance(30_000);
    limiter.hit('b');
    advance(30_000);
    limiter.cleanup();
    expect(limiter.size).toBe(1);
  });

  it('stays bounded by maxKeys', () => {
    const { limiter } = setup(5, 2);
    ['a', 'b', 'c', 'd'].forEach((k) => limiter.hit(k));
    expect(limiter.size).toBe(2);
  });

  it('limit 0 disables it', () => {
    const { limiter } = setup(0);
    for (let i = 0; i < 1000; i++) expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.size).toBe(0);
  });
});
