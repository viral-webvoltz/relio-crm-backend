import { describe, expect, it } from 'vitest';
import { nextRunAt } from './reports.next-run.js';

const at = (iso: string) => new Date(iso);
const daily = (hourUtc: number) => ({ frequency: 'daily', hourUtc, dayOfWeek: null, dayOfMonth: null });
const weekly = (hourUtc: number, dayOfWeek: number) => ({ frequency: 'weekly', hourUtc, dayOfWeek, dayOfMonth: null });
const monthly = (hourUtc: number, dayOfMonth: number) => ({ frequency: 'monthly', hourUtc, dayOfWeek: null, dayOfMonth });

describe('nextRunAt daily', () => {
  it('runs later today when the hour has not passed', () => {
    expect(nextRunAt(daily(9), at('2026-03-10T08:59:59Z')).toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });
  it('is strictly after from: exactly on the hour goes to tomorrow', () => {
    expect(nextRunAt(daily(9), at('2026-03-10T09:00:00Z')).toISOString()).toBe('2026-03-11T09:00:00.000Z');
  });
  it('rolls over month and year ends', () => {
    expect(nextRunAt(daily(0), at('2026-12-31T00:00:01Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextRunAt(daily(23), at('2026-02-28T23:30:00Z')).toISOString()).toBe('2026-03-01T23:00:00.000Z');
  });
});

describe('nextRunAt weekly', () => {
  // 2026-03-10 is a Tuesday (2)
  it('finds the weekday later this week', () => {
    expect(nextRunAt(weekly(6, 5), at('2026-03-10T10:00:00Z')).toISOString()).toBe('2026-03-13T06:00:00.000Z');
  });
  it('runs today when the weekday matches and the hour is ahead', () => {
    expect(nextRunAt(weekly(12, 2), at('2026-03-10T10:00:00Z')).toISOString()).toBe('2026-03-10T12:00:00.000Z');
  });
  it('goes a full week ahead when the hour has passed or equals from', () => {
    expect(nextRunAt(weekly(10, 2), at('2026-03-10T10:00:00Z')).toISOString()).toBe('2026-03-17T10:00:00.000Z');
  });
  it('wraps to an earlier weekday next week (Sunday = 0)', () => {
    expect(nextRunAt(weekly(8, 0), at('2026-03-10T10:00:00Z')).toISOString()).toBe('2026-03-15T08:00:00.000Z');
  });
});

describe('nextRunAt monthly', () => {
  it('runs this month when the day is ahead', () => {
    expect(nextRunAt(monthly(7, 20), at('2026-03-10T10:00:00Z')).toISOString()).toBe('2026-03-20T07:00:00.000Z');
  });
  it('goes to next month when the moment has passed or equals from', () => {
    expect(nextRunAt(monthly(7, 10), at('2026-03-10T07:00:00Z')).toISOString()).toBe('2026-04-10T07:00:00.000Z');
  });
  it('rolls December into January', () => {
    expect(nextRunAt(monthly(0, 1), at('2026-12-15T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('day 28 exists in February, including leap years', () => {
    expect(nextRunAt(monthly(5, 28), at('2026-02-01T00:00:00Z')).toISOString()).toBe('2026-02-28T05:00:00.000Z');
    expect(nextRunAt(monthly(5, 28), at('2028-02-28T05:00:00Z')).toISOString()).toBe('2028-03-28T05:00:00.000Z');
  });
  it('from the last day of a month still lands on the right day next month', () => {
    expect(nextRunAt(monthly(5, 28), at('2026-01-31T23:59:59Z')).toISOString()).toBe('2026-02-28T05:00:00.000Z');
  });
});
