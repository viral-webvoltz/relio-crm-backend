import { describe, expect, it } from 'vitest';
import { addDays, cycleFrom, localDate, nextRunOn, occurrence } from './subscriptions.schedule.js';

describe('occurrence', () => {
  it('steps by weeks', () => {
    expect([0, 1, 2].map((k) => occurrence('2026-11-02', 'week', 2, k))).toEqual(['2026-11-02', '2026-11-16', '2026-11-30']);
  });

  it('keeps the day of the month, clamping to short months without drifting', () => {
    expect([0, 1, 2, 3].map((k) => occurrence('2026-01-31', 'month', 1, k))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(occurrence('2024-01-31', 'month', 1, 1)).toBe('2024-02-29'); // leap year
  });

  it('rolls over the year, and steps by years', () => {
    expect(occurrence('2026-11-15', 'month', 3, 1)).toBe('2027-02-15');
    expect(occurrence('2024-02-29', 'year', 1, 1)).toBe('2025-02-28');
    expect(occurrence('2024-02-29', 'year', 1, 4)).toBe('2028-02-29');
  });
});

describe('nextRunOn', () => {
  const base = { startOn: '2026-01-31', unit: 'month' as const, every: 1, endOn: null, maxRuns: null };

  it('is the occurrence after the runs done so far', () => {
    expect(nextRunOn({ ...base, cycle: 0, runCount: 0 })).toBe('2026-01-31');
    expect(nextRunOn({ ...base, cycle: 2, runCount: 2 })).toBe('2026-03-31');
  });

  it('ends at the maximum number of runs or the end date', () => {
    expect(nextRunOn({ ...base, cycle: 3, runCount: 3, maxRuns: 3 })).toBeNull();
    expect(nextRunOn({ ...base, cycle: 2, runCount: 2, maxRuns: 3 })).toBe('2026-03-31');
    expect(nextRunOn({ ...base, cycle: 2, runCount: 2, endOn: '2026-03-30' })).toBeNull();
    expect(nextRunOn({ ...base, cycle: 2, runCount: 2, endOn: '2026-03-31' })).toBe('2026-03-31');
  });

  it('counts skipped dates as cycles but not as runs', () => {
    // 4 dates passed, only 1 invoiced: two more runs are still allowed under a limit of 3
    expect(nextRunOn({ ...base, cycle: 4, runCount: 1, maxRuns: 3 })).toBe('2026-05-31');
    expect(nextRunOn({ ...base, cycle: 4, runCount: 3, maxRuns: 3 })).toBeNull();
  });

  it('resumes from the first date that is not in the past', () => {
    // paused after cycle 1 (Feb), resumed on 10 May: Feb, Mar, Apr dates are skipped, May's is still ahead on the 31st
    expect(cycleFrom('2026-01-31', 'month', 1, 1, '2026-05-10')).toBe(4);
    expect(cycleFrom('2026-01-31', 'month', 1, 1, '2026-02-28')).toBe(1); // today counts as not past
  });
});

describe('dates', () => {
  it('adds days across month ends', () => {
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
  });

  it('reads the date on the wall clock of a timezone', () => {
    const instant = new Date('2026-11-01T20:00:00Z'); // already the 2nd in Kolkata
    expect(localDate(instant, 'UTC')).toBe('2026-11-01');
    expect(localDate(instant, 'Asia/Kolkata')).toBe('2026-11-02');
  });
});
