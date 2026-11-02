import { z } from 'zod';
import { MAX_MONEY_MINOR } from '@/shared/constants/limits.js';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { cfFilterField, customFieldsInput, withCfFilters } from '@/modules/custom-fields/custom-fields.validation.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

// No defaults in the base: partial() keeps defaults, which would overwrite fields on PATCH.
const dealFields = z.object({
  title: z.string().trim().min(1).max(200),
  valueMinor: z.number().int().min(0).max(MAX_MONEY_MINOR),
  currency: z.string().trim().length(3).toUpperCase(),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(''))
    .transform((v) => v || null)
    .nullish(),
  contactId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
  customFields: customFieldsInput,
});

export const createDealSchema = dealFields.extend({
  valueMinor: dealFields.shape.valueMinor.default(0),
  currency: dealFields.shape.currency.default('USD'),
  stageId: z.uuid().optional(), // defaults to the first stage of the default pipeline
});

export const updateDealSchema = dealFields.partial();

export const moveDealSchema = z.object({
  stageId: z.uuid(),
  lostReason: optionalText(500),
});

export const dealListQuerySchema = withCfFilters(listQuerySchema.extend({ stageId: z.uuid().optional(), cf: cfFilterField }));

export type DealListQuery = z.infer<typeof dealListQuerySchema>;
export type CreateDealInput = z.infer<typeof createDealSchema>;
export type UpdateDealInput = z.infer<typeof updateDealSchema>;
export type MoveDealInput = z.infer<typeof moveDealSchema>;
