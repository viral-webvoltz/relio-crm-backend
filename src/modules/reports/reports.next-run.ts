export type ScheduleTiming = { frequency: string; hourUtc: number; dayOfWeek: number | null; dayOfMonth: number | null };

const DAY_MS = 24 * 60 * 60 * 1000;

// First run time strictly after `from`, in UTC. dayOfMonth is capped at 28 by validation, so every month has it.
export function nextRunAt({ frequency, hourUtc, dayOfWeek, dayOfMonth }: ScheduleTiming, from: Date): Date {
  const y = from.getUTCFullYear();
  const mo = from.getUTCMonth();
  if (frequency === 'monthly') {
    const day = dayOfMonth ?? 1;
    const thisMonth = new Date(Date.UTC(y, mo, day, hourUtc));
    return thisMonth > from ? thisMonth : new Date(Date.UTC(y, mo + 1, day, hourUtc));
  }
  let candidate = new Date(Date.UTC(y, mo, from.getUTCDate(), hourUtc));
  if (frequency === 'weekly') {
    const target = dayOfWeek ?? 0;
    candidate = new Date(candidate.getTime() + ((target - candidate.getUTCDay() + 7) % 7) * DAY_MS);
    return candidate > from ? candidate : new Date(candidate.getTime() + 7 * DAY_MS);
  }
  return candidate > from ? candidate : new Date(candidate.getTime() + DAY_MS);
}
