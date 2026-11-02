import { z } from 'zod';
import { batchSchema } from '@/shared/batch/index.js';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { cfFilterField, customFieldsInput, withCfFilters } from '@/modules/custom-fields/custom-fields.validation.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

export const createContactSchema = z.object({
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
  jobTitle: optionalText(100),
  notes: optionalText(5000),
  companyId: z.uuid().nullish(),
  customFields: customFieldsInput,
});

export const updateContactSchema = createContactSchema.partial();

export const contactListQuerySchema = withCfFilters(listQuerySchema.extend({ cf: cfFilterField }));
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

// Fields a bulk update may change; everything else is rejected.
export const batchContactsSchema = batchSchema(updateContactSchema.pick({ companyId: true }));
export type BatchContactsInput = z.infer<typeof batchContactsSchema>;
