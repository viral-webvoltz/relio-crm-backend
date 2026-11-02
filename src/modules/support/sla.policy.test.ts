import { describe, expect, it } from 'vitest';
import { addWorkMinutes, defaultPolicy, dueDates, firstResponseState, resolutionState, type BusinessHours } from './sla.policy.js';

const iso = (d: Date) => d.toISOString();
const weekdays9to5: BusinessHours = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

describe('addWorkMinutes', () => {
  it('is plain elapsed time without business hours', () => {
    expect(iso(addWorkMinutes(new Date('2026-11-06T22:00:00Z'), 180, null))).toBe('2026-11-07T01:00:00.000Z');
  });

  it('counts only working time, rolling over the weekend', () => {
    // Fri 16:00 + 2h: one hour left on Friday, one on Monday morning
    expect(iso(addWorkMinutes(new Date('2026-11-06T16:00:00Z'), 120, weekdays9to5))).toBe('2026-11-09T10:00:00.000Z');
    // Sat noon + 1h: the clock starts Monday at opening
    expect(iso(addWorkMinutes(new Date('2026-11-07T12:00:00Z'), 60, weekdays9to5))).toBe('2026-11-09T10:00:00.000Z');
    // before opening, and inside the day
    expect(iso(addWorkMinutes(new Date('2026-11-09T07:00:00Z'), 30, weekdays9to5))).toBe('2026-11-09T09:30:00.000Z');
    expect(iso(addWorkMinutes(new Date('2026-11-09T09:30:00Z'), 60, weekdays9to5))).toBe('2026-11-09T10:30:00.000Z');
  });

  it('spans several working days', () => {
    // 20 working hours from Monday 09:00 = 2.5 days of 8h
    expect(iso(addWorkMinutes(new Date('2026-11-09T09:00:00Z'), 20 * 60, weekdays9to5))).toBe('2026-11-11T13:00:00.000Z');
  });

  it('reads the hours on the wall clock of the timezone', () => {
    const kolkata: BusinessHours = { timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
    // Mon 03:00Z is 08:30 in Kolkata, so 30 working minutes end at 09:30 local = 04:00Z
    expect(iso(addWorkMinutes(new Date('2026-11-09T03:00:00Z'), 30, kolkata))).toBe('2026-11-09T04:00:00.000Z');
  });

  it('follows a daylight-saving change', () => {
    const newYork: BusinessHours = { timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
    // Fri 30 Oct 16:00 EDT (20:00Z) + 2h: 1h Friday (closes 17:00 EDT = 21:00Z), then Monday 2 Nov, after the clocks went back,
    // opens 09:00 EST = 14:00Z, so 1h more ends 10:00 EST = 15:00Z
    expect(iso(addWorkMinutes(new Date('2026-10-30T20:00:00Z'), 120, newYork))).toBe('2026-11-02T15:00:00.000Z');
  });
});

describe('dueDates', () => {
  it('uses the target of the priority', () => {
    const from = new Date('2026-11-09T09:00:00Z');
    expect(dueDates(defaultPolicy, 'urgent', from)).toEqual({
      firstResponseDueAt: new Date('2026-11-09T09:30:00Z'),
      resolutionDueAt: new Date('2026-11-09T13:00:00Z'),
    });
  });
});

describe('SLA state', () => {
  const created = new Date('2026-11-09T09:00:00Z');
  const due = new Date('2026-11-09T19:00:00Z'); // 10h window, 80% = 17:00
  const ticket = { status: 'open', createdAt: created, slaDueAt: due, resolvedAt: null };
  const at = (hhmm: string) => new Date(`2026-11-09T${hhmm}:00Z`);

  it('moves from ok to warning to breached while open', () => {
    expect(resolutionState(ticket, 80, at('12:00'))).toBe('ok');
    expect(resolutionState(ticket, 80, at('17:00'))).toBe('warning');
    expect(resolutionState(ticket, 80, at('19:01'))).toBe('breached');
  });

  it('pauses while waiting on the customer and judges a finished ticket by when it was finished', () => {
    expect(resolutionState({ ...ticket, status: 'pending' }, 80, at('23:00'))).toBe('paused');
    expect(resolutionState({ ...ticket, status: 'resolved', resolvedAt: at('18:00') }, 80, at('23:00'))).toBe('met');
    expect(resolutionState({ ...ticket, status: 'closed', resolvedAt: at('20:00') }, 80, at('23:00'))).toBe('missed');
  });

  it('tracks the first response separately, and has none for tickets without a target', () => {
    const t = { status: 'open', createdAt: created, firstResponseDueAt: at('10:00'), firstRespondedAt: null };
    expect(firstResponseState(t, 80, at('09:30'))).toBe('ok');
    expect(firstResponseState(t, 80, at('09:50'))).toBe('warning');
    expect(firstResponseState(t, 80, at('10:01'))).toBe('breached');
    expect(firstResponseState({ ...t, firstRespondedAt: at('09:40') }, 80, at('12:00'))).toBe('met');
    expect(firstResponseState({ ...t, firstRespondedAt: at('10:30') }, 80, at('12:00'))).toBe('missed');
    expect(firstResponseState({ ...t, firstResponseDueAt: null }, 80, at('12:00'))).toBeNull();
    expect(firstResponseState({ ...t, status: 'resolved' }, 80, at('12:00'))).toBeNull();
  });
});
