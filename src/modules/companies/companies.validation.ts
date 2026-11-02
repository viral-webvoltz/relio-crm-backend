import { z } from 'zod';
import { batchSchema } from '@/shared/batch/index.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(150),
  website: optionalText(200).refine((v) => !v || /^https?:\/\//i.test(v), 'Website must start with http:// or https://'),
  industry: optionalText(100),
  phone: optionalText(40),
  notes: optionalText(5000),
});

export const updateCompanySchema = createCompanySchema.partial();

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

// Fields a bulk update may change; everything else is rejected.
export const batchCompaniesSchema = batchSchema(updateCompanySchema.pick({ industry: true }));
export type BatchCompaniesInput = z.infer<typeof batchCompaniesSchema>;
