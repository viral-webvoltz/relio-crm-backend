import { describe, expect, it } from 'vitest';
import { leastLoaded, nextRoundRobin } from './assignment.pick.js';

describe('nextRoundRobin', () => {
  const team = ['c', 'a', 'b'];

  it('walks the members in id order and wraps round', () => {
    expect(nextRoundRobin(team, null)).toBe('a');
    expect(nextRoundRobin(team, 'a')).toBe('b');
    expect(nextRoundRobin(team, 'b')).toBe('c');
    expect(nextRoundRobin(team, 'c')).toBe('a');
  });

  it('continues sensibly when the previous person left or someone joined', () => {
    expect(nextRoundRobin(['a', 'c'], 'b')).toBe('c'); // b left: carry on after where b was
    expect(nextRoundRobin(['a', 'b', 'bb', 'c'], 'b')).toBe('bb'); // a newcomer slots into the rotation
    expect(nextRoundRobin(['a'], 'a')).toBe('a');
  });

  it('gives nobody for an empty team', () => {
    expect(nextRoundRobin([], null)).toBeNull();
  });

  it('shares a long run of records evenly', () => {
    const counts: Record<string, number> = {};
    let last: string | null = null;
    for (let i = 0; i < 300; i++) {
      last = nextRoundRobin(team, last)!;
      counts[last] = (counts[last] ?? 0) + 1;
    }
    expect(counts).toEqual({ a: 100, b: 100, c: 100 });
  });
});

describe('leastLoaded', () => {
  it('picks the person with the fewest open items, ties to the lowest id', () => {
    expect(
      leastLoaded([
        { userId: 'b', open: 2 },
        { userId: 'a', open: 5 },
        { userId: 'c', open: 2 },
      ]),
    ).toBe('b');
    expect(
      leastLoaded([
        { userId: 'z', open: 0 },
        { userId: 'y', open: 0 },
      ]),
    ).toBe('y');
  });

  it('gives nobody for an empty list', () => {
    expect(leastLoaded([])).toBeNull();
  });
});
