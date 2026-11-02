import { z } from 'zod';

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  roleIds: z.array(z.uuid()).min(1).max(10),
});

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  isActive: z.boolean().optional(),
  roleIds: z.array(z.uuid()).min(1).max(10).optional(),
  password: z.string().min(8).max(128).optional(), // admin password reset; also signs the user out everywhere
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
