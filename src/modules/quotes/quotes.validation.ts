import { z } from 'zod';
import { MAX_MONEY_MINOR } from '@/shared/constants/limits.js';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const quoteStatuses = ['draft', 'sent', 'accepted', 'rejected'] as const;
// "expired" is not stored: it is a sent quote past its valid-until date, so it can be filtered for but never set.
export const quoteListStatuses = [...quoteStatuses, 'expired'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const discountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().int().min(0).max(10_000) }), // basis points
  z.object({ type: z.literal('fixed'), value: z.number().int().min(0).max(MAX_MONEY_MINOR) }), // minor units
]);

const itemSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(100_000),
  // Omitted: the catalogue price. Given: the price being offered to this customer.
  unitPriceMinor: z.number().int().min(0).max(MAX_MONEY_MINOR).optional(),
  description: optionalText(500),
});

const items = z
  .array(itemSchema)
  .min(1)
  .max(100)
  .refine((list) => new Set(list.map((i) => i.productId)).size === list.length, 'List each product once; change its quantity instead');

const base = z.object({
  contactId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
  dealId: z.uuid().nullish(),
  items,
  discount: discountSchema.nullish(),
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
  validUntil: date.nullish(),
  notes: optionalText(2000),
  terms: optionalText(5000),
});

export const createQuoteSchema = base.strict();
export const updateQuoteSchema = base.partial().strict();

export const sendQuoteSchema = z.object({ to: z.email().max(254).optional() }).strict();

export const convertQuoteSchema = z
  .object({
    target: z.enum(['order', 'invoice']).default('order'), // invoice = the order and its invoice, in one step
    dueDate: date.nullish(),
  })
  .strict();

// What the customer submits from the public link.
export const acceptQuoteSchema = z.object({ name: z.string().trim().min(1).max(120), note: optionalText(1000) }).strict();
export const rejectQuoteSchema = z.object({ note: optionalText(1000) }).strict();

export const quoteTokenParamSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });

export const quoteListQuerySchema = listQuerySchema.extend({
  status: z.enum(quoteListStatuses).optional(),
  contactId: z.uuid().optional(),
  dealId: z.uuid().optional(),
});

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
export type SendQuoteInput = z.infer<typeof sendQuoteSchema>;
export type ConvertQuoteInput = z.infer<typeof convertQuoteSchema>;
export type AcceptQuoteInput = z.infer<typeof acceptQuoteSchema>;
export type RejectQuoteInput = z.infer<typeof rejectQuoteSchema>;
export type QuoteListQuery = z.infer<typeof quoteListQuerySchema>;
