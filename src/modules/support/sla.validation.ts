import { z } from 'zod';
import { isTimezone } from '@/modules/workflows/workflows.graph.js';

const MAX_MINUTES = 90 * 24 * 60;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const target = z
  .object({ firstResponseMinutes: z.number().int().min(1).max(MAX_MINUTES), resolutionMinutes: z.number().int().min(1).max(MAX_MINUTES) })
  .refine((t) => t.firstResponseMinutes <= t.resolutionMinutes, 'The first reply cannot be due after the resolution');

const businessHours = z
  .object({
    timezone: z.string().trim().max(60).refine(isTimezone, 'Unknown timezone'),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'List each day once'),
    start: hhmm,
    end: hhmm,
  })
  .refine((h) => h.start < h.end, 'Opening time must be before closing time');

export const slaPolicySchema = z
  .object({
    targets: z.object({ urgent: target, high: target, medium: target, low: target }),
    businessHours: businessHours.nullable(),
    warnAtPercent: z.number().int().min(1).max(99).default(80),
    // Also move the deadlines of tickets that are open right now; otherwise only new tickets (and priority changes) follow the new policy.
    applyToOpen: z.boolean().default(false),
  })
  .strict();

export const slaSummaryQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export type SlaPolicyInput = z.infer<typeof slaPolicySchema>;
export type SlaSummaryQuery = z.infer<typeof slaSummaryQuerySchema>;
