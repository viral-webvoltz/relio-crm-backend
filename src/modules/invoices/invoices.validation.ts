import { z } from 'zod';
import { MAX_MONEY_MINOR } from '@/shared/constants/limits.js';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const paymentMethods = ['cash', 'card', 'bank_transfer', 'upi', 'other'] as const;
export const invoiceListStatuses = ['unpaid', 'partial', 'paid', 'void', 'overdue'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

export const createInvoiceSchema = z.object({
  orderId: z.uuid(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(''))
    .transform((v) => v || null)
    .nullish(),
  notes: optionalText(2000),
});

export const recordPaymentSchema = z.object({
  amountMinor: z.number().int().min(1).max(MAX_MONEY_MINOR),
  method: z.enum(paymentMethods),
  reference: optionalText(200),
  paidAt: z.iso.datetime().optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

export const refundSchema = z.object({
  amountMinor: z.number().int().min(1).max(MAX_MONEY_MINOR),
  reason: optionalText(500),
});

export const invoiceListQuerySchema = listQuerySchema.extend({
  status: z.enum(invoiceListStatuses).optional(),
  orderId: z.uuid().optional(),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
