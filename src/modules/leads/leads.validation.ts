import { z } from 'zod';
import { batchSchema } from '@/shared/batch/index.js';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { cfFilterField, customFieldsInput, withCfFilters } from '@/modules/custom-fields/custom-fields.validation.js';

export const leadSources = ['website', 'referral', 'social', 'email', 'event', 'other'] as const;
export const leadStatuses = ['new', 'contacted', 'qualified', 'unqualified'] as const; // "converted" is only set by the convert use case
export const leadPriorities = ['low', 'medium', 'high'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

// No defaults here: partial() keeps defaults, which would overwrite fields on PATCH.
const leadFields = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: optionalText(100),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(200)
    .or(z.literal(''))
    .transform((v) => v || null)
    .nullish(),
  phone: optionalText(40),
  companyName: optionalText(150),
  source: z.enum(leadSources),
  status: z.enum(leadStatuses),
  priority: z.enum(leadPriorities),
  score: z.number().int().min(0).max(100),
  assignedTo: z.uuid().nullish(),
  followUpDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(''))
    .transform((v) => v || null)
    .nullish(),
  notes: optionalText(5000),
  customFields: customFieldsInput,
});

export const createLeadSchema = leadFields.extend({
  source: leadFields.shape.source.default('other'),
  status: leadFields.shape.status.default('new'),
  priority: leadFields.shape.priority.default('medium'),
  score: leadFields.shape.score.default(0),
});

export const updateLeadSchema = leadFields.partial();

export const leadListQuerySchema = withCfFilters(
  listQuerySchema.extend({
    cf: cfFilterField,
    status: z.enum([...leadStatuses, 'converted']).optional(),
    priority: z.enum(leadPriorities).optional(),
    source: z.enum(leadSources).optional(),
  }),
);

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

// Fields a bulk update may change; everything else is rejected.
export const batchLeadsSchema = batchSchema(updateLeadSchema.pick({ status: true, priority: true, assignedTo: true }));
export type BatchLeadsInput = z.infer<typeof batchLeadsSchema>;
