import { describe, expect, it } from 'vitest';
import { fillMonthly, monthKeys } from './reports.buckets.js';

describe('monthKeys', () => {
  it('lists every month touched by a half-open range', () => {
    expect(monthKeys(new Date('2026-11-15T00:00:00Z'), new Date('2027-02-01T00:00:00Z'))).toEqual(['2026-11', '2026-12', '2027-01']);
  });
  it('includes the month of the last day when end is the next day', () => {
    expect(monthKeys(new Date('2026-03-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'))).toEqual(['2026-03']);
    expect(monthKeys(new Date('2026-03-01T00:00:00Z'), new Date('2026-04-02T00:00:00Z'))).toEqual(['2026-03', '2026-04']);
  });
});

describe('fillMonthly', () => {
  const months = ['2026-01', '2026-02', '2026-03'];

  it('zero-fills missing months for every currency present', () => {
    const rows = fillMonthly(months, [
      { month: '2026-02', currency: 'USD', field: 'invoicedMinor', value: 500 },
      { month: '2026-01', currency: 'EUR', field: 'orderCount', value: 2 },
    ]);
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.month === '2026-02' && r.currency === 'USD')?.invoicedMinor).toBe(500);
    expect(rows.find((r) => r.month === '2026-03' && r.currency === 'EUR')).toMatchObject({ invoicedMinor: 0, orderCount: 0 });
  });

  it('adds entries for the same cell (payments minus refunds)', () => {
    const rows = fillMonthly(
      ['2026-01'],
      [
        { month: '2026-01', currency: 'USD', field: 'collectedMinor', value: 1000 },
        { month: '2026-01', currency: 'USD', field: 'collectedMinor', value: -300 },
      ],
    );
    expect(rows).toEqual([{ month: '2026-01', currency: 'USD', invoicedMinor: 0, collectedMinor: 700, orderCount: 0, orderTotalMinor: 0 }]);
  });

  it('returns one zero row per month with a null currency when there is no data', () => {
    const rows = fillMonthly(months, []);
    expect(rows.map((r) => [r.month, r.currency])).toEqual([
      ['2026-01', null],
      ['2026-02', null],
      ['2026-03', null],
    ]);
  });

  it('ignores entries outside the requested months', () => {
    const rows = fillMonthly(['2026-01'], [{ month: '2025-12', currency: 'USD', field: 'invoicedMinor', value: 9 }]);
    expect(rows).toEqual([{ month: '2026-01', currency: null, invoicedMinor: 0, collectedMinor: 0, orderCount: 0, orderTotalMinor: 0 }]);
  });
});
