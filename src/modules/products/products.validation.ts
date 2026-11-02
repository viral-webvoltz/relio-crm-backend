import { z } from 'zod';
import { MAX_MONEY_MINOR } from '@/shared/constants/limits.js';
import { batchSchema } from '@/shared/batch/index.js';
import { listQuerySchema } from '@/shared/pagination/index.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

// No defaults in the base: partial() keeps defaults, which would overwrite fields on PATCH.
const productFields = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .max(64)
    .transform((v) => v || null)
    .nullish(),
  description: optionalText(5000),
  categoryId: z.uuid().nullish(),
  priceMinor: z.number().int().min(0).max(MAX_MONEY_MINOR),
  currency: z.string().trim().length(3).toUpperCase(),
  trackInventory: z.boolean(),
  reorderLevel: z.number().int().min(0).max(1_000_000),
  isActive: z.boolean(),
});

export const createProductSchema = productFields.extend({
  priceMinor: productFields.shape.priceMinor.default(0),
  currency: productFields.shape.currency.default('USD'),
  trackInventory: productFields.shape.trackInventory.default(true),
  reorderLevel: productFields.shape.reorderLevel.default(0),
  isActive: productFields.shape.isActive.default(true),
  initialStock: z.number().int().min(0).max(1_000_000).default(0), // later changes go through stock adjustments
});

export const updateProductSchema = productFields.partial();

export const adjustStockSchema = z.object({
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, 'Adjustment cannot be zero'),
  reason: optionalText(200),
});

export const productListQuerySchema = listQuerySchema.extend({
  categoryId: z.uuid().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const categorySchema = z.object({ name: z.string().trim().min(1).max(100) });

export type CategoryInput = z.infer<typeof categorySchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

// Fields a bulk update may change; everything else is rejected.
export const batchProductsSchema = batchSchema(updateProductSchema.pick({ isActive: true, categoryId: true }));
export type BatchProductsInput = z.infer<typeof batchProductsSchema>;
