import { z } from 'zod';

export const contactIdParamSchema = z.object({ contactId: z.uuid() });

export const createAccountSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(8).max(128) });

export const updateAccountSchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  password: z.string().min(8).max(128).optional(), // admin reset; also signs the customer out everywhere
  isActive: z.boolean().optional(),
});

export type ContactIdParams = z.infer<typeof contactIdParamSchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
