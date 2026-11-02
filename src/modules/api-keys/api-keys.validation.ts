import { z } from 'zod';
import { permissionKeys, type PermissionKey } from '@/shared/constants/permissions.js';

// Never grantable to a key: these let the holder manage people and settings (including creating more keys), which belongs to a signed-in person.
export const NEVER_FOR_KEYS: readonly PermissionKey[] = ['users.manage', 'settings.manage', 'privacy.manage'];
export const grantableScopes = permissionKeys.filter((k) => !NEVER_FOR_KEYS.includes(k));

const scope = z.enum(grantableScopes as [PermissionKey, ...PermissionKey[]]);

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(scope)
      .min(1)
      .max(grantableScopes.length)
      .refine((s) => new Set(s).size === s.length, 'List each scope once'),
    expiresInDays: z.number().int().min(1).max(730).nullish(), // none = it does not expire until revoked
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
