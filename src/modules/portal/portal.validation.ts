import { z } from 'zod';

export const customerLoginSchema = z.object({
  organizationSlug: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export type CustomerLoginInput = z.infer<typeof customerLoginSchema>;

// Only these contact fields are customer-editable; email, ids and organization are never accepted.
export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100).nullable(),
    phone: z.string().trim().max(40).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

const maxAdvanceMs = 180 * 24 * 60 * 60 * 1000;

export const createAppointmentSchema = z.object({
  subject: z.string().trim().min(1).max(150),
  notes: z.string().trim().min(1).max(1000).optional(),
  startsAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), { message: 'Must be in the future' })
    .refine((d) => d.getTime() <= Date.now() + maxAdvanceMs, { message: 'Must be within 180 days' }),
  durationMinutes: z.number().int().min(15).max(240).default(30),
});

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
