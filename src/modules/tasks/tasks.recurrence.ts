import type { TaskRecurrence } from './tasks.validation.js';

const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

// Next due date for a repeating task, from "YYYY-MM-DD", in UTC so time zones cannot shift the day.
// Monthly keeps the day number but clamps to the month's end (31 Jan -> 28/29 Feb).
export function nextDueDate(due: string, recurrence: Exclude<TaskRecurrence, 'none'>) {
  const [year, month, day] = due.split('-').map(Number) as [number, number, number];
  if (recurrence === 'monthly') {
    const target = new Date(Date.UTC(year, month, 1)); // month is 1-based, so this is the following month
    const y = target.getUTCFullYear();
    const m = target.getUTCMonth();
    return new Date(Date.UTC(y, m, Math.min(day, lastDayOfMonth(y, m)))).toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(year, month - 1, day + (recurrence === 'daily' ? 1 : 7))).toISOString().slice(0, 10);
}

if (process.argv[1]?.endsWith('tasks.recurrence.ts')) {
  const expect = (actual: string, wanted: string) => {
    if (actual !== wanted) throw new Error(`expected ${wanted}, got ${actual}`);
  };
  expect(nextDueDate('2026-10-30', 'daily'), '2026-10-31');
  expect(nextDueDate('2026-12-31', 'daily'), '2027-01-01');
  expect(nextDueDate('2026-10-30', 'weekly'), '2026-11-06');
  expect(nextDueDate('2026-01-31', 'monthly'), '2026-02-28');
  expect(nextDueDate('2028-01-31', 'monthly'), '2028-02-29');
  expect(nextDueDate('2026-12-15', 'monthly'), '2027-01-15');
  console.log('recurrence ok');
}
