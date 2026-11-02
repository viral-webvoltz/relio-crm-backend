import { describe, expect, it } from 'vitest';
import { elapsedShare, goalState, periodRange } from './goals.period.js';

describe('periodRange', () => {
  it('finds the month, including February and leap years', () => {
    expect(periodRange('month', '2026-11-15')).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(periodRange('month', '2026-02-10')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(periodRange('month', '2028-02-29')).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29' });
    expect(periodRange('month', '2026-12-31')).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31' });
  });

  it('finds the quarter and the year', () => {
    expect(periodRange('quarter', '2026-01-01')).toEqual({ startDate: '2026-01-01', endDate: '2026-03-31' });
    expect(periodRange('quarter', '2026-05-20')).toEqual({ startDate: '2026-04-01', endDate: '2026-06-30' });
    expect(periodRange('quarter', '2026-09-30')).toEqual({ startDate: '2026-07-01', endDate: '2026-09-30' });
    expect(periodRange('quarter', '2026-11-01')).toEqual({ startDate: '2026-10-01', endDate: '2026-12-31' });
    expect(periodRange('year', '2026-06-15')).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' });
  });
});

describe('elapsedShare', () => {
  it('counts the current day as done and stays within 0 and 1', () => {
    expect(elapsedShare('2026-11-01', '2026-11-30', '2026-11-15')).toBe(0.5);
    expect(elapsedShare('2026-11-01', '2026-11-30', '2026-11-01')).toBeCloseTo(1 / 30);
    expect(elapsedShare('2026-11-01', '2026-11-30', '2026-10-20')).toBe(0);
    expect(elapsedShare('2026-11-01', '2026-11-30', '2026-12-20')).toBe(1);
  });
});

describe('goalState', () => {
  const base = { target: 1000, startDate: '2026-11-01', endDate: '2026-11-30' };

  it('is achieved as soon as the target is met, even early or after the period', () => {
    expect(goalState({ ...base, actual: 1000, today: '2026-11-03' })).toBe('achieved');
    expect(goalState({ ...base, actual: 1200, today: '2026-12-30' })).toBe('achieved');
  });

  it('compares a running period with the straight-line pace', () => {
    expect(goalState({ ...base, actual: 500, today: '2026-11-15' })).toBe('ahead'); // exactly on pace
    expect(goalState({ ...base, actual: 499, today: '2026-11-15' })).toBe('behind');
  });

  it('is upcoming before the start and missed after the end', () => {
    expect(goalState({ ...base, actual: 0, today: '2026-10-31' })).toBe('upcoming');
    expect(goalState({ ...base, actual: 999, today: '2026-12-01' })).toBe('missed');
  });
});
