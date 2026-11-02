import { describe, expect, it } from 'vitest';
import { isSlaBreached, slaDueAt } from './tickets.sla.js';

const created = new Date('2026-11-02T09:00:00Z');

describe('slaDueAt', () => {
  it('sets the deadline from creation time and priority', () => {
    expect(slaDueAt(created, 'urgent').toISOString()).toBe('2026-11-02T13:00:00.000Z');
    expect(slaDueAt(created, 'high').toISOString()).toBe('2026-11-03T09:00:00.000Z');
    expect(slaDueAt(created, 'medium').toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(slaDueAt(created, 'low').toISOString()).toBe('2026-11-07T09:00:00.000Z');
  });
});

describe('isSlaBreached', () => {
  const due = new Date('2026-11-03T09:00:00Z');
  const after = new Date('2026-11-03T09:00:01Z');
  const before = new Date('2026-11-03T08:59:59Z');

  it('breaches only an open ticket that is past its deadline', () => {
    expect(isSlaBreached({ status: 'open', slaDueAt: due }, after)).toBe(true);
    expect(isSlaBreached({ status: 'open', slaDueAt: due }, before)).toBe(false);
  });

  it('does not run while waiting on the customer or once resolved or closed', () => {
    for (const status of ['pending', 'resolved', 'closed']) {
      expect(isSlaBreached({ status, slaDueAt: due }, after)).toBe(false);
    }
  });
});
