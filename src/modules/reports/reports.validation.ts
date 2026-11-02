import { z } from 'zod';
import { BadRequestError } from '@/shared/errors/index.js';

export const REPORT_TYPES = ['revenue-by-month', 'pipeline-velocity', 'leads-funnel'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_YEARS = 5;
const DEFAULT_MONTHS = 12;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const reportQuerySchema = z.object({ from: dateOnly.optional(), to: dateOnly.optional() });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

// Saved params use the same schema as the report's own query; kept per type so they can diverge.
export const reportParamsSchemas = {
  'revenue-by-month': reportQuerySchema,
  'pipeline-velocity': reportQuerySchema,
  'leads-funnel': reportQuerySchema,
} satisfies Record<ReportType, z.ZodType>;

const nameSchema = z.string().trim().min(1).max(80);

export const createSavedSchema = z
  .object({
    name: nameSchema,
    reportType: z.enum(REPORT_TYPES),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const updateSavedSchema = z
  .object({ name: nameSchema, params: z.record(z.string(), z.unknown()) })
  .partial()
  .strict();
export type CreateSavedInput = z.infer<typeof createSavedSchema>;
export type UpdateSavedInput = z.infer<typeof updateSavedSchema>;

const scheduleFields = {
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  hourUtc: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6).nullish(),
  dayOfMonth: z.number().int().min(1).max(28).nullish(),
  recipients: z
    .array(z.email().max(254).toLowerCase())
    .min(1)
    .max(10)
    .transform((list) => [...new Set(list)]),
  isActive: z.boolean(),
};

// Weekly needs a weekday, monthly a day of month; the other day field is dropped so rows stay consistent.
export const scheduleShapeSchema = z
  .object(scheduleFields)
  .superRefine((s, ctx) => {
    if (s.frequency === 'weekly' && s.dayOfWeek == null)
      ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: 'dayOfWeek is required for weekly schedules' });
    if (s.frequency === 'monthly' && s.dayOfMonth == null)
      ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'dayOfMonth is required for monthly schedules' });
  })
  .transform((s) => ({
    ...s,
    dayOfWeek: s.frequency === 'weekly' ? (s.dayOfWeek ?? null) : null,
    dayOfMonth: s.frequency === 'monthly' ? (s.dayOfMonth ?? null) : null,
  }));
export type ScheduleShape = z.output<typeof scheduleShapeSchema>;

export const createScheduleSchema = z.object({ ...scheduleFields, savedReportId: z.uuid(), isActive: scheduleFields.isActive.default(true) }).strict();
export const updateScheduleSchema = z.object(scheduleFields).partial().strict();
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

const parseDay = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestError(`Invalid date "${value}"`, 'INVALID_RANGE');
  return date;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

// Inclusive UTC calendar days. Defaults to the 12 calendar months ending with the current one (up to today).
export function resolveRange({ from, to }: ReportQuery, now = new Date()) {
  const last = to ? parseDay(to) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const first = from ? parseDay(from) : new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - (DEFAULT_MONTHS - 1), 1));
  if (first > last) throw new BadRequestError('"from" must not be after "to"', 'INVALID_RANGE');
  const limit = Date.UTC(first.getUTCFullYear() + MAX_RANGE_YEARS, first.getUTCMonth(), first.getUTCDate());
  if (last.getTime() >= limit) throw new BadRequestError(`The range cannot span more than ${MAX_RANGE_YEARS} years`, 'INVALID_RANGE');
  const end = new Date(last.getTime() + DAY_MS); // half-open: start <= x < end
  return { start: first, end, from: isoDay(first), to: isoDay(last), endDay: isoDay(end) };
}
export type ResolvedRange = ReturnType<typeof resolveRange>;
