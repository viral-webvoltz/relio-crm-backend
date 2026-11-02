import { z } from 'zod';
import { MAX_MONEY_MINOR } from '@/shared/constants/limits.js';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { intervalUnits } from './subscriptions.schedule.js';

export const subscriptionStatuses = ['active', 'paused', 'cancelled', 'completed'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const discountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().int().min(0).max(10_000) }),
  z.object({ type: z.literal('fixed'), value: z.number().int().min(0).max(MAX_MONEY_MINOR) }),
]);

const items = z
  .array(
    z.object({
      productId: z.uuid(),
      quantity: z.number().int().min(1).max(100_000),
      unitPriceMinor: z.number().int().min(0).max(MAX_MONEY_MINOR).optional(), // omitted: the catalogue price today, then fixed
    }),
  )
  .min(1)
  .max(50)
  .refine((list) => new Set(list.map((i) => i.productId)).size === list.length, 'List each product once; change its quantity instead');

const base = z.object({
  name: z.string().trim().min(1).max(120),
  contactId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
  items,
  discount: discountSchema.nullish(),
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
  intervalUnit: z.enum(intervalUnits),
  intervalCount: z.number().int().min(1).max(52).default(1),
  startOn: date,
  endOn: date.nullish(),
  maxRuns: z.number().int().min(1).max(1200).nullish(),
  dueDays: z.number().int().min(0).max(365).default(14),
  autoSend: z.boolean().default(false),
  notes: optionalText(2000),
});

const endsAfterStart = (input: { startOn?: string | undefined; endOn?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (input.startOn && input.endOn && input.endOn < input.startOn)
    ctx.addIssue({ code: 'custom', path: ['endOn'], message: 'The end date is before the start date' });
};

export const createSubscriptionSchema = base.strict().superRefine(endsAfterStart);
// What can change on a live subscription: the terms of future invoices. The schedule (start date, interval) is fixed once created.
export const updateSubscriptionSchema = base
  .pick({ name: true, items: true, discount: true, taxRateBps: true, endOn: true, maxRuns: true, dueDays: true, autoSend: true, notes: true })
  .partial()
  .strict();

export const subscriptionListQuerySchema = listQuerySchema.extend({
  status: z.enum(subscriptionStatuses).optional(),
  contactId: z.uuid().optional(),
});

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;
export type SubscriptionListQuery = z.infer<typeof subscriptionListQuerySchema>;
