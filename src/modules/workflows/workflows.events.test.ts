import { describe, expect, it } from 'vitest';
import { sanitizeValues } from './workflows.events.js';
import { localParts } from './workflows.schedule.js';
import { isBlockedError, sendRequest } from '@/modules/webhooks/webhooks.http.js';

describe('queued event values', () => {
  it('drops credentials at any depth and keeps everything else', () => {
    const clean = sanitizeValues({
      name: 'Acme',
      passwordHash: 'x',
      nested: { apiToken: 'y', ok: 1 },
      list: [{ secret: 's', keep: true }],
      when: new Date('2026-01-01T00:00:00Z'),
    });
    expect(clean).toEqual({ name: 'Acme', nested: { ok: 1 }, list: [{ keep: true }], when: '2026-01-01T00:00:00.000Z' });
  });

  it('cuts an oversized record down to its top-level scalars, shortening long strings', () => {
    const clean = sanitizeValues({ title: 'Big', count: 3, notes: 'x'.repeat(60_000), object: { a: 1 } });
    expect(clean).toEqual({ title: 'Big', count: 3, notes: 'x'.repeat(1_000) });
  });
});

describe('outbound HTTP step', () => {
  it('refuses a name that resolves to a loopback address, at connection time', async () => {
    const err = await sendRequest({ url: 'https://localhost:1/hook', method: 'POST', body: '{}', timeoutMs: 2_000 }).catch((e: unknown) => e);
    expect(isBlockedError(err)).toBe(true);
  });
});

describe('local clock for schedules', () => {
  it('reads the wall clock of a timezone, including the date and weekday', () => {
    const instant = new Date('2026-04-07T22:00:00Z'); // Tuesday evening in UTC
    expect(localParts(instant, 'UTC')).toEqual({ date: '2026-04-07', time: '22:00', weekday: 'tue' });
    expect(localParts(instant, 'Asia/Kolkata')).toEqual({ date: '2026-04-08', time: '03:30', weekday: 'wed' });
    expect(localParts(new Date('2026-04-07T00:00:00Z'), 'America/New_York').date).toBe('2026-04-06');
  });
});
