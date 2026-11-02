import { describe, expect, it } from 'vitest';
import { resolveRange } from './dashboard.validation.js';

const now = new Date('2026-03-15T10:30:00Z');

describe('resolveRange', () => {
  it('defaults to the last 30 days ending today (inclusive)', () => {
    const r = resolveRange({}, now);
    expect(r.label).toEqual({ from: '2026-02-14', to: '2026-03-15', previousFrom: '2026-01-15', previousTo: '2026-02-13' });
    expect(r.current.start.toISOString()).toBe('2026-02-14T00:00:00.000Z');
    expect(r.current.end.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('previous window has the same length and ends where current starts', () => {
    const r = resolveRange({ from: '2026-03-01', to: '2026-03-10' }, now);
    expect(r.previous.end).toEqual(r.current.start);
    expect(r.current.end.getTime() - r.current.start.getTime()).toBe(r.current.start.getTime() - r.previous.start.getTime());
    expect(r.label.previousFrom).toBe('2026-02-19');
    expect(r.label.previousTo).toBe('2026-02-28');
  });

  it('allows a single day and exactly 366 days', () => {
    expect(() => resolveRange({ from: '2026-03-01', to: '2026-03-01' }, now)).not.toThrow();
    expect(() => resolveRange({ from: '2025-03-15', to: '2026-03-15' }, now)).not.toThrow(); // 366 inclusive days
  });

  it.each([
    ['from after to', { from: '2026-03-10', to: '2026-03-01' }],
    ['more than 366 days', { from: '2025-03-14', to: '2026-03-15' }],
    ['invalid calendar date', { from: '2026-02-30', to: '2026-03-01' }],
    ['invalid "to" date', { to: '2026-13-01' }],
  ])('rejects %s with INVALID_RANGE', (_n, q) => {
    expect(() => resolveRange(q, now)).toThrowError(expect.objectContaining({ code: 'INVALID_RANGE', statusCode: 400 }));
  });
});
