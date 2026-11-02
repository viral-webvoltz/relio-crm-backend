import { z } from 'zod';
import { isTimezone } from '@/modules/workflows/workflows.graph.js';

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    timezone: z.string().trim().max(60).refine(isTimezone, 'Unknown timezone'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

const account = {
  fromEmail: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  fromName: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => v || null),
  clientId: z.string().trim().min(1).max(300),
};

export const createMailAccountSchema = z
  .object({ ...account, clientSecret: z.string().trim().min(1).max(500), refreshToken: z.string().trim().min(1).max(2000) })
  .strict();

// A blank secret means "keep what is stored", so editing the name never needs the secrets again.
export const updateMailAccountSchema = z
  .object({ ...account, clientSecret: z.string().trim().max(500).optional(), refreshToken: z.string().trim().max(2000).optional() })
  .strict();

export const testMailSchema = z.object({ to: z.email().max(254).optional() }).strict();

export type CreateMailAccountBody = z.infer<typeof createMailAccountSchema>;
export type UpdateMailAccountBody = z.infer<typeof updateMailAccountSchema>;
export type TestMailBody = z.infer<typeof testMailSchema>;
