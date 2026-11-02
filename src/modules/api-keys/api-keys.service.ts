import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { apiKeys, users } from '@/database/schema/index.js';
import { authRepository } from '@/modules/auth/auth.repository.js';
import { hashToken } from '@/modules/auth/auth.service.js';
import { permissionKeys, type PermissionKey } from '@/shared/constants/permissions.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { grantableScopes, type CreateApiKeyInput } from './api-keys.validation.js';

export const KEY_PREFIX = 'crm_';
const MAX_ACTIVE_KEYS = 25;
const TOUCH_AFTER_MS = 60_000;
const isPermissionKey = (key: string): key is PermissionKey => (permissionKeys as readonly string[]).includes(key);

const active = and(isNull(apiKeys.revokedAt), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)));

class ApiKeysService {
  // What the caller may put on a key: only what they can do themselves, and never the management rights.
  scopesFor(permissions: readonly string[]) {
    return grantableScopes.filter((s) => permissions.includes(s));
  }

  async list(organizationId: string) {
    return db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
        createdByName: users.fullName,
      })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.createdBy))
      .where(eq(apiKeys.organizationId, organizationId))
      .orderBy(desc(apiKeys.createdAt));
  }

  // The key is returned here and nowhere else.
  async create({
    organizationId,
    userId,
    permissions,
    input,
  }: {
    organizationId: string;
    userId: string;
    permissions: readonly string[];
    input: CreateApiKeyInput;
  }) {
    const missing = input.scopes.filter((s) => !permissions.includes(s));
    if (missing.length) throw new ForbiddenError(`You cannot give a key rights you do not have: ${missing.join(', ')}`);

    const [live] = await db
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, organizationId), isNull(apiKeys.revokedAt)));
    if ((live?.n ?? 0) >= MAX_ACTIVE_KEYS)
      throw new ConflictError(`An organization can have at most ${MAX_ACTIVE_KEYS} active API keys; revoke one first`, 'TOO_MANY_KEYS');

    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const [row] = await db
      .insert(apiKeys)
      .values({
        organizationId,
        name: input.name,
        keyPrefix: key.slice(0, 12),
        keyHash: hashToken(key),
        scopes: input.scopes,
        createdBy: userId,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning();
    await audit({
      organizationId,
      actorUserId: userId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: row!.id,
      metadata: { name: input.name, scopes: input.scopes },
    });
    return { id: row!.id, name: row!.name, keyPrefix: row!.keyPrefix, scopes: row!.scopes, expiresAt: row!.expiresAt, key };
  }

  async revoke({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }) {
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, name: apiKeys.name });
    if (!row) throw new NotFoundError('API key not found');
    await audit({ organizationId, actorUserId: userId, action: 'api_key.revoked', targetType: 'api_key', targetId: id, metadata: { name: row.name } });
  }

  // Called for every request that carries a key. Null for anything that does not work (unknown, revoked, expired, its owner gone), so the
  // caller answers all of them the same way. The key's rights are the chosen scopes, cut down to what its owner can still do today.
  async authenticate(rawKey: string) {
    if (!rawKey.startsWith(KEY_PREFIX) || rawKey.length > 100) return null;
    const [row] = await db
      .select({
        id: apiKeys.id,
        organizationId: apiKeys.organizationId,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        userActive: users.isActive,
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.createdBy))
      .where(and(eq(apiKeys.keyHash, hashToken(rawKey)), active));
    if (!row?.userActive) return null;

    const owned = new Set(await authRepository.listUserPermissionKeys({ userId: row.userId }));
    const permissions = row.scopes.filter(isPermissionKey).filter((s) => owned.has(s));
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
    }
    return { keyId: row.id, userId: row.userId, organizationId: row.organizationId, email: row.email, fullName: row.fullName, permissions };
  }
}

export const apiKeysService = new ApiKeysService();
