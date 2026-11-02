import { z } from 'zod';

const passwordRule = z.string().min(8).max(128);

export const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(100),
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: passwordRule,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
  // Optional: a person with one account needs only email and password. The slug or the organization's name both work.
  organizationSlug: z.string().trim().min(1).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordRule });
export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetPasswordSchema = z.object({ token: z.string().min(1).max(256), newPassword: passwordRule });
export const sessionParamsSchema = z.object({ id: z.string().uuid() });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
