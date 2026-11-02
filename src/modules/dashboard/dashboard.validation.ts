import { z } from 'zod';
import { BadRequestError } from '@/shared/errors/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const summaryQuerySchema = z.object({ from: dateOnly.optional(), to: dateOnly.optional() });
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;

export type DateWindow = { start: Date; end: Date }; // half-open: start <= x < end

const parseDay = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestError(`Invalid date "${value}"`, 'INVALID_RANGE');
  return date;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

// Inclusive calendar days in UTC. Defaults to the last 30 days ending today; `previous` is the same-length window right before.
export function resolveRange({ from, to }: SummaryQuery, now = new Date()) {
  const last = to ? parseDay(to) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const first = from ? parseDay(from) : new Date(last.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  if (first > last) throw new BadRequestError('"from" must not be after "to"', 'INVALID_RANGE');
  const days = Math.round((last.getTime() - first.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw new BadRequestError(`The range cannot span more than ${MAX_RANGE_DAYS} days`, 'INVALID_RANGE');

  const current: DateWindow = { start: first, end: new Date(last.getTime() + DAY_MS) };
  const previous: DateWindow = { start: new Date(first.getTime() - days * DAY_MS), end: first };
  return {
    current,
    previous,
    label: { from: isoDay(first), to: isoDay(last), previousFrom: isoDay(previous.start), previousTo: isoDay(new Date(first.getTime() - DAY_MS)) },
  };
}
