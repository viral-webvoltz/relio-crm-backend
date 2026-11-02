import { z } from 'zod';
import { MAX_MONEY_MINOR } from '@/shared/constants/limits.js';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const orderStatuses = ['pending', 'confirmed', 'fulfilled', 'cancelled'] as const;

const discountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().int().min(0).max(10_000) }), // basis points
  z.object({ type: z.literal('fixed'), value: z.number().int().min(0).max(MAX_MONEY_MINOR) }), // minor units
]);

export const createOrderSchema = z.object({
  contactId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
  items: z
    .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100_000) }))
    .min(1)
    .max(100),
  discount: discountSchema.nullish(),
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
  notes: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v || null)
    .nullish(),
});

export const changeStatusSchema = z.object({
  status: z.enum(orderStatuses),
  note: z
    .string()
    .trim()
    .max(500)
    .transform((v) => v || null)
    .nullish(),
});

export const orderListQuerySchema = listQuerySchema.extend({ status: z.enum(orderStatuses).optional() });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
export type OrderStatus = (typeof orderStatuses)[number];
