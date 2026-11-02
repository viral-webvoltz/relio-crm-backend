export const intervalUnits = ['week', 'month', 'year'] as const;
export type IntervalUnit = (typeof intervalUnits)[number];

const parse = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
};
const format = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// The k-th billing date (k = 0 is the start date itself), counted from the START date and not from the previous one, so a subscription that
// begins on the 31st bills on the last day of shorter months and then goes back to the 31st, instead of drifting to the 28th for good.
export function occurrence(startOn: string, unit: IntervalUnit, every: number, k: number): string {
  const { y, m, d } = parse(startOn);
  if (unit === 'week') {
    const t = new Date(Date.UTC(y, m - 1, d + 7 * every * k));
    return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  const months = (unit === 'year' ? 12 : 1) * every * k;
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return format(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

// The wall-clock date in an IANA timezone, as YYYY-MM-DD.
export const localDate = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export const addDays = (date: string, days: number) => {
  const { y, m, d } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

// `cycle` billing dates have passed (billed or skipped) and `runCount` invoices were made: when is the next billing date, and does the
// subscription end first? null = it is finished. Dates skipped while paused count as cycles but not as runs.
export function nextRunOn({
  startOn,
  unit,
  every,
  cycle,
  runCount,
  endOn,
  maxRuns,
}: {
  startOn: string;
  unit: IntervalUnit;
  every: number;
  cycle: number;
  runCount: number;
  endOn: string | null;
  maxRuns: number | null;
}): string | null {
  if (maxRuns !== null && runCount >= maxRuns) return null;
  const next = occurrence(startOn, unit, every, cycle);
  return endOn !== null && next > endOn ? null : next;
}

// First cycle whose billing date is today or later: what a resumed subscription continues from, so it never bills the time it was paused.
export function cycleFrom(startOn: string, unit: IntervalUnit, every: number, from: number, today: string): number {
  let cycle = from;
  while (occurrence(startOn, unit, every, cycle) < today) cycle++;
  return cycle;
}
