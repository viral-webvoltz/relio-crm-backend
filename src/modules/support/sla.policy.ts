import { slaHours, ticketPriorities, type TicketPriority } from './tickets.sla.js';

export type Target = { firstResponseMinutes: number; resolutionMinutes: number };
// Working hours: the SLA clock only runs on these days (0 = Sunday .. 6 = Saturday) between start and end, on the wall clock of `timezone`.
export type BusinessHours = { timezone: string; days: number[]; start: string; end: string };
export type SlaPolicy = { targets: Record<TicketPriority, Target>; businessHours: BusinessHours | null; warnAtPercent: number };

// Out of the box: round-the-clock, resolution as before this feature existed, and a first-reply target a sixth of the way in.
export const defaultPolicy: SlaPolicy = {
  targets: {
    urgent: { firstResponseMinutes: 30, resolutionMinutes: slaHours.urgent * 60 },
    high: { firstResponseMinutes: 120, resolutionMinutes: slaHours.high * 60 },
    medium: { firstResponseMinutes: 480, resolutionMinutes: slaHours.medium * 60 },
    low: { firstResponseMinutes: 1440, resolutionMinutes: slaHours.low * 60 },
  },
  businessHours: null,
  warnAtPercent: 80,
};

const MS_PER_MINUTE = 60_000;
const MAX_DAYS = 400; // ponytail: a policy with working days always finds capacity quickly; this only bounds a pathological one (e.g. a 1-minute window and a 90-day target)
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function wallClock(instant: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    asUtc: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)),
  };
}

// The instant at which the wall clock of `timeZone` reads this calendar date and minute-of-day. Two passes settle daylight-saving shifts.
function instantAt(y: number, m: number, d: number, minutes: number, timeZone: string): Date {
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  const offsetAt = (t: number) => wallClock(new Date(Math.floor(t / 1000) * 1000), timeZone).asUtc - Math.floor(t / 1000) * 1000;
  const first = naive - offsetAt(naive);
  return new Date(naive - offsetAt(first));
}

// `start` plus `minutes` of working time. Without business hours it is plain elapsed time.
export function addWorkMinutes(start: Date, minutes: number, hours: BusinessHours | null): Date {
  if (!hours) return new Date(start.getTime() + minutes * MS_PER_MINUTE);
  const opens = toMinutes(hours.start);
  const closes = toMinutes(hours.end);
  const first = wallClock(start, hours.timezone);
  let remaining = minutes;
  for (let i = 0; i < MAX_DAYS; i++) {
    const day = new Date(Date.UTC(first.y, first.m - 1, first.d + i)); // calendar arithmetic only: its weekday is the local weekday
    if (!hours.days.includes(day.getUTCDay())) continue;
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const open = instantAt(y, m, d, opens, hours.timezone);
    const close = instantAt(y, m, d, closes, hours.timezone);
    const from = start > open ? start : open;
    if (from >= close) continue;
    const available = (close.getTime() - from.getTime()) / MS_PER_MINUTE;
    if (remaining <= available) return new Date(from.getTime() + remaining * MS_PER_MINUTE);
    remaining -= available;
  }
  return new Date(start.getTime() + minutes * MS_PER_MINUTE);
}

export function dueDates(policy: SlaPolicy, priority: TicketPriority, from: Date) {
  const target = policy.targets[priority];
  return {
    firstResponseDueAt: addWorkMinutes(from, target.firstResponseMinutes, policy.businessHours),
    resolutionDueAt: addWorkMinutes(from, target.resolutionMinutes, policy.businessHours),
  };
}

export type SlaState = 'ok' | 'warning' | 'breached' | 'paused' | 'met' | 'missed';

const isFinished = (status: string) => status === 'resolved' || status === 'closed';
const percentElapsed = (createdAt: Date, dueAt: Date, now: Date) =>
  ((now.getTime() - createdAt.getTime()) / Math.max(1, dueAt.getTime() - createdAt.getTime())) * 100;

// Where a clock stands. The clock only runs while the ticket is open: waiting on the customer pauses it, finishing stops it.
function liveState(status: string, createdAt: Date, dueAt: Date, warnAtPercent: number, now: Date): SlaState {
  if (status === 'pending') return 'paused';
  if (now > dueAt) return 'breached';
  return percentElapsed(createdAt, dueAt, now) >= warnAtPercent ? 'warning' : 'ok';
}

export function resolutionState(
  ticket: { status: string; createdAt: Date; slaDueAt: Date; resolvedAt: Date | null },
  warnAtPercent: number,
  now = new Date(),
): SlaState {
  if (isFinished(ticket.status)) return (ticket.resolvedAt ?? now) <= ticket.slaDueAt ? 'met' : 'missed';
  return liveState(ticket.status, ticket.createdAt, ticket.slaDueAt, warnAtPercent, now);
}

// null: this ticket has no first-response target (it predates the feature), or it was finished without anyone replying.
export function firstResponseState(
  ticket: { status: string; createdAt: Date; firstResponseDueAt: Date | null; firstRespondedAt: Date | null },
  warnAtPercent: number,
  now = new Date(),
): SlaState | null {
  if (!ticket.firstResponseDueAt) return null;
  if (ticket.firstRespondedAt) return ticket.firstRespondedAt <= ticket.firstResponseDueAt ? 'met' : 'missed';
  if (isFinished(ticket.status)) return null;
  return liveState(ticket.status, ticket.createdAt, ticket.firstResponseDueAt, warnAtPercent, now);
}

export { ticketPriorities };
