export const periodTypes = ['month', 'quarter', 'year', 'custom'] as const;
export type PeriodType = (typeof periodTypes)[number];

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const parse = (date: string) => date.split('-').map(Number) as [number, number, number];
const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Math.floor(Date.UTC(...(parse(date).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number])) / DAY_MS);

// The calendar month, quarter or year that contains `on`: first and last day, inclusive.
export function periodRange(type: Exclude<PeriodType, 'custom'>, on: string): { startDate: string; endDate: string } {
  const [y, m] = parse(on);
  if (type === 'year') return { startDate: iso(y, 1, 1), endDate: iso(y, 12, 31) };
  const first = type === 'month' ? m : m - ((m - 1) % 3);
  const last = type === 'month' ? m : first + 2;
  return { startDate: iso(y, first, 1), endDate: iso(y, last + 1, 0) };
}

export type GoalState = 'upcoming' | 'achieved' | 'ahead' | 'behind' | 'missed';

// How far through the period `today` is, as a share of its days (0 before it starts, 1 once it is over).
export function elapsedShare(startDate: string, endDate: string, today: string): number {
  const total = dayNumber(endDate) - dayNumber(startDate) + 1;
  const done = dayNumber(today) - dayNumber(startDate) + 1;
  return Math.min(1, Math.max(0, done / total));
}

// Achieved beats everything. Otherwise a finished period is missed, an unstarted one is upcoming, and a running one is ahead or behind
// the straight-line pace towards the target.
export function goalState({
  actual,
  target,
  startDate,
  endDate,
  today,
}: {
  actual: number;
  target: number;
  startDate: string;
  endDate: string;
  today: string;
}): GoalState {
  if (actual >= target) return 'achieved';
  if (today > endDate) return 'missed';
  if (today < startDate) return 'upcoming';
  return actual >= target * elapsedShare(startDate, endDate, today) ? 'ahead' : 'behind';
}
