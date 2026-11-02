import { and, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { organizations, permissions, rolePermissions, sessions, userRoles, users } from '@/database/schema/index.js';
import { passwordResetTokens } from '@/database/schema/security.js';
import { slugify } from './slug.js';

class AuthRepository {
  async findOrganizationIdBySlug({ slug }: { slug: string }, executor: DbExecutor = db) {
    const [org] = await executor.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
    return org;
  }

  async findOrganization({ id }: { id: string }) {
    const [org] = await db.select({ name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, id));
    return org;
  }

  async createOrganization({ name, slug }: { name: string; slug: string }, executor: DbExecutor = db) {
    const [org] = await executor.insert(organizations).values({ name, slug }).returning({ id: organizations.id });
    return org!;
  }

  // Every account with this email (several organizations may share one address), narrowed to one organization when it is named.
  async findCredentials({ organization, email }: { organization?: string; email: string }) {
    const named = organization
      ? or(
          eq(organizations.slug, organization),
          eq(sql`lower(${organizations.name})`, organization.toLowerCase()),
          eq(organizations.slug, slugify(organization)),
        )
      : undefined;
    return db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        isActive: users.isActive,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
      })
      .from(users)
      .innerJoin(organizations, eq(users.organizationId, organizations.id))
      .where(and(eq(users.email, email), named))
      .limit(20);
  }

  async updatePasswordHash({ userId, passwordHash }: { userId: string; passwordHash: string }, executor: DbExecutor = db) {
    await executor.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  }

  async findPasswordHash({ userId }: { userId: string }) {
    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
    return row?.passwordHash;
  }

  async createUserRole({ userId, roleId }: { userId: string; roleId: string }, executor: DbExecutor = db) {
    await executor.insert(userRoles).values({ userId, roleId });
  }

  async createSession(values: { userId: string; tokenHash: string; expiresAt: Date; userAgent: string | null; ipAddress: string | null }) {
    await db.insert(sessions).values({ ...values, lastSeenAt: new Date() });
  }

  async updateSession({ id, expiresAt, lastSeenAt }: { id: string; expiresAt?: Date; lastSeenAt: Date }) {
    await db.update(sessions).set({ expiresAt, lastSeenAt }).where(eq(sessions.id, id));
  }

  async listActiveSessions({ userId }: { userId: string }) {
    return db
      .select({
        id: sessions.id,
        tokenHash: sessions.tokenHash,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        userAgent: sessions.userAgent,
        ipAddress: sessions.ipAddress,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .orderBy(sessions.createdAt);
  }

  async deleteSession({ id, userId }: { id: string; userId: string }) {
    const rows = await db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  async deleteOtherSessions({ userId, keepTokenHash }: { userId: string; keepTokenHash: string }, executor: DbExecutor = db) {
    const rows = await executor
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepTokenHash)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  async findActiveUsersByEmail({ email }: { email: string }) {
    return db
      .select({ id: users.id, organizationId: users.organizationId, fullName: users.fullName, organizationName: organizations.name })
      .from(users)
      .innerJoin(organizations, eq(users.organizationId, organizations.id))
      .where(and(eq(users.email, email), eq(users.isActive, true)));
  }

  async deleteUnusedResetTokens({ userId }: { userId: string }, executor: DbExecutor = db) {
    await executor.delete(passwordResetTokens).where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  }

  async createResetToken(values: { userId: string; tokenHash: string; expiresAt: Date; ipAddress: string | null }, executor: DbExecutor = db) {
    await executor.insert(passwordResetTokens).values(values);
  }

  // Row lock so two concurrent resets with one token cannot both succeed.
  async findResetTokenForUpdate({ tokenHash }: { tokenHash: string }, executor: DbExecutor) {
    const [row] = await executor
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
        usedAt: passwordResetTokens.usedAt,
        organizationId: users.organizationId,
        isActive: users.isActive,
      })
      .from(passwordResetTokens)
      .innerJoin(users, eq(users.id, passwordResetTokens.userId))
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .for('update', { of: passwordResetTokens });
    return row;
  }

  async markResetTokenUsed({ id }: { id: string }, executor: DbExecutor) {
    await executor.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, id));
  }

  async deleteSessionByTokenHash({ tokenHash }: { tokenHash: string }) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  async findActiveSessionUser({ tokenHash }: { tokenHash: string }) {
    const [row] = await db
      .select({
        id: users.id,
        organizationId: users.organizationId,
        email: users.email,
        fullName: users.fullName,
        sessionId: sessions.id,
        sessionExpiresAt: sessions.expiresAt,
        sessionLastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date()), eq(users.isActive, true)));
    return row;
  }

  async listUserPermissionKeys({ userId }: { userId: string }) {
    const rows = await db
      .selectDistinct({ key: permissions.key })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(userRoles.userId, userId));
    return rows.map((r) => r.key);
  }
}

export const authRepository = new AuthRepository();
