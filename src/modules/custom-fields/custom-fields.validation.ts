import { z } from 'zod';
import { entityTypes, extractCfFilters, fieldTypes } from './custom-fields.validate.js';

export const MAX_ACTIVE_DEFINITIONS = 30;

// Shared by the lead/contact/deal create and update schemas; values are checked against the org's definitions in the service.
export const customFieldsInput = z.record(z.string().max(40), z.unknown()).optional();

const options = z.array(z.string().trim().min(1).max(100)).min(1).max(50);
const uniqueOptions = (o: string[]) => new Set(o).size === o.length;

export const createDefinitionSchema = z
  .object({
    entityType: z.enum(entityTypes),
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    label: z.string().trim().min(1).max(100),
    type: z.enum(fieldTypes),
    options: options.optional(),
    required: z.boolean().default(false),
    position: z.number().int().min(0).max(10000).optional(),
  })
  .refine((v) => (v.type === 'select' ? Boolean(v.options) && uniqueOptions(v.options ?? []) : v.options === undefined), {
    message: 'Select fields need unique options; other types must not have options',
    path: ['options'],
  });

// key and type are immutable: unknown keys (including those) are rejected.
export const updateDefinitionSchema = z.strictObject({
  label: z.string().trim().min(1).max(100).optional(),
  options: options.refine(uniqueOptions, 'Options must be unique').optional(),
  required: z.boolean().optional(),
  position: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

export const listDefinitionsQuerySchema = z.object({
  entityType: z.enum(entityTypes),
  includeInactive: z.enum(['true', 'false']).optional(),
});

export type CreateDefinitionInput = z.infer<typeof createDefinitionSchema>;
export type UpdateDefinitionInput = z.infer<typeof updateDefinitionSchema>;
export type ListDefinitionsQuery = z.infer<typeof listDefinitionsQuerySchema>;

// List queries: `cf[<key>]=<value>` equality filters, collected into `query.cf`.
export const cfFilterField = z.record(z.string(), z.string()).optional();
export const withCfFilters = <T extends z.ZodType>(schema: T) =>
  z.preprocess((raw) => (typeof raw === 'object' && raw !== null ? { ...raw, cf: extractCfFilters(raw) } : raw), schema);
