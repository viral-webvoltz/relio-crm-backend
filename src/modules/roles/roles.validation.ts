import { z } from 'zod';
import { permissionKeys } from '@/shared/constants/permissions.js';

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  permissions: z.array(z.enum(permissionKeys)).max(permissionKeys.length),
});

export const updateRoleSchema = createRoleSchema.partial();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
