import { z } from 'zod';
import { MAX_MONEY_MINOR } from '@/shared/constants/limits.js';
import { periodTypes } from './goals.period.js';

export const metrics = ['revenue_won', 'deals_won', 'orders_value', 'leads_converted', 'quotes_accepted', 'tickets_resolved'] as const;
export type Metric = (typeof metrics)[number];
export const moneyMetrics: readonly Metric[] = ['revenue_won', 'orders_value'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);

const scope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organization') }),
  z.object({ type: z.literal('team'), teamId: z.uuid() }),
  z.object({ type: z.literal('user'), userId: z.uuid() }),
]);

export const createGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    metric: z.enum(metrics),
    scope,
    period: z.enum(periodTypes),
    on: date.optional(), // month, quarter, year: any day inside it (default today)
    startDate: date.optional(), // custom only
    endDate: date.optional(),
    target: z.number().int().min(1).max(MAX_MONEY_MINOR),
    currency: currency.optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    const money = moneyMetrics.includes(g.metric);
    if (money && !g.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'A money goal needs a currency' });
    if (!money && g.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'Only money goals have a currency' });
    if (g.period === 'custom') {
      if (!g.startDate || !g.endDate) ctx.addIssue({ code: 'custom', path: ['startDate'], message: 'A custom period needs startDate and endDate' });
      else if (g.endDate < g.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date is before the start date' });
    } else if (g.startDate || g.endDate) ctx.addIssue({ code: 'custom', path: ['startDate'], message: 'startDate and endDate are only for a custom period' });
  });

// The measuring stick (metric, scope, period) is fixed once set, so progress history stays meaningful; the target and name can change.
export const updateGoalSchema = z
  .object({ name: z.string().trim().min(1).max(120), target: z.number().int().min(1).max(MAX_MONEY_MINOR) })
  .partial()
  .strict();

export const goalListQuerySchema = z.object({
  metric: z.enum(metrics).optional(),
  userId: z.uuid().optional(),
  when: z.enum(['current', 'past', 'all']).default('current'),
});

export const leaderboardQuerySchema = z
  .object({
    metric: z.enum(metrics),
    period: z.enum(['month', 'quarter', 'year']).default('month'),
    on: date.optional(),
    currency: currency.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .superRefine((q, ctx) => {
    if (moneyMetrics.includes(q.metric) && !q.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'A money metric needs a currency' });
  });

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type GoalListQuery = z.infer<typeof goalListQuerySchema>;
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
