import { createHash, randomBytes } from 'node:crypto';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from '@/shared/utils/password.js';
import { appConfig } from '@/config/app.config.js';
import { withTransaction } from '@/config/database.js';
import { env } from '@/config/env.js';
import { permissionKeys, type PermissionKey } from '@/shared/constants/permissions.js';
import { AppError, BadRequestError, NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { logger } from '@/shared/utils/logger.js';
import { queueEmail } from '@/modules/mail/mail.service.js';
import { esc } from '@/modules/mail/mail.templates.js';
import { ensureDefaultRoles, ensureOwnerRole } from '@/modules/roles/roles.defaults.js';
import { rolesRepository } from '@/modules/roles/roles.repository.js';
import { usersRepository } from '@/modules/users/users.repository.js';
import { twoFactorService } from './two-factor.service.js';
import type { TwoFactorLoginInput } from './two-factor.validation.js';
import { authRepository } from './auth.repository.js';
import { slugify } from './slug.js';
import { generateResetToken, hashResetToken, isResetTokenUsable } from './reset-token.js';
import type { ChangePasswordInput, ForgotPasswordInput, LoginInput, RegisterInput, ResetPasswordInput } from './auth.validation.js';

export type SessionMeta = { userAgent: string | null; ipAddress: string | null };

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const isPermissionKey = (key: string): key is PermissionKey => permissionKeys.some((k) => k === key);

// Expiry is always (last refresh + ttl), so "more than sessionRefreshAfterMs since the last refresh" needs no extra column.
export const sessionNeedsRefresh = (expiresAt: Date, now: number) => expiresAt.getTime() - now < appConfig.sessionTtlMs - appConfig.sessionRefreshAfterMs;

class AuthService {
  async registerOrganization(input: RegisterInput, meta: SessionMeta) {
    const passwordHash = await hashPassword(input.password);
    const baseSlug = slugify(input.organizationName) || 'org';

    const userId = await withTransaction(async (tx) => {
      const existing = await authRepository.findOrganizationIdBySlug({ slug: baseSlug }, tx);
      const slug = existing ? `${baseSlug}-${randomBytes(3).toString('hex')}` : baseSlug;

      const org = await authRepository.createOrganization({ name: input.organizationName, slug }, tx);
      const user = await usersRepository.create({ organizationId: org.id, email: input.email, fullName: input.fullName, passwordHash }, tx);

      await rolesRepository.ensurePermissionKeys({ keys: permissionKeys }, tx);
      const allPermissions = await rolesRepository.findPermissionIds({ keys: permissionKeys }, tx);
      const ownerRole = await ensureOwnerRole(tx, org.id);
      await rolesRepository.insertRolePermissions({ roleId: ownerRole.id, permissionIds: allPermissions.map((p) => p.id) }, tx);
      await authRepository.createUserRole({ userId: user.id, roleId: ownerRole.id }, tx);
      await ensureDefaultRoles(tx, org.id);
      return user.id;
    });

    return this.createSession(userId, meta);
  }

  async login(input: LoginInput, meta: SessionMeta) {
    const candidates = await authRepository.findCredentials({ organization: input.organizationSlug, email: input.email });

    // Check the password against every account with this email (normally one); with none, still do one check so timing never shows whether the email exists.
    const verified = [];
    for (const candidate of candidates) {
      if ((await verifyPassword(input.password, candidate.passwordHash)) && candidate.isActive) verified.push(candidate);
    }
    if (candidates.length === 0) await verifyPassword(input.password, await dummyHash());

    if (verified.length === 0) throw new UnauthorizedError('Invalid email, password or organization', 'INVALID_CREDENTIALS');
    // Only a correct password gets here, so listing the organizations tells nobody anything they could not already open.
    if (verified.length > 1) {
      throw new AppError(
        'This email has accounts in several organizations. Choose one.',
        409,
        'ORGANIZATION_REQUIRED',
        verified.map((v) => ({ slug: v.organizationSlug, name: v.organizationName })),
      );
    }
    const row = verified[0]!;
    if (needsRehash(row.passwordHash)) await authRepository.updatePasswordHash({ userId: row.id, passwordHash: await hashPassword(input.password) });
    // With two-factor on, the password only earns a short-lived challenge; the session comes after the one-time code.
    if (await twoFactorService.isEnabled(row.id)) return { challengeToken: twoFactorService.challengeFor(row.id) } as const;
    return { session: await this.createSession(row.id, meta) } as const;
  }

  async completeTwoFactorLogin({ challengeToken, code, recoveryCode }: TwoFactorLoginInput, meta: SessionMeta) {
    const userId = await twoFactorService.completeLogin({ challengeToken, factor: { code, recoveryCode } });
    return this.createSession(userId, meta);
  }

  async getOrganization(organizationId: string) {
    return (await authRepository.findOrganization({ id: organizationId })) ?? null;
  }

  async logout(token: string) {
    await authRepository.deleteSessionByTokenHash({ tokenHash: hashToken(token) });
  }

  async getUserBySessionToken(token: string) {
    const found = await authRepository.findActiveSessionUser({ tokenHash: hashToken(token) });
    if (!found) return null;
    const { sessionId, sessionExpiresAt, sessionLastSeenAt, ...user } = found;

    const now = Date.now();
    const refresh = sessionNeedsRefresh(sessionExpiresAt, now);
    const touch = !sessionLastSeenAt || now - sessionLastSeenAt.getTime() > appConfig.sessionTouchMs;
    const refreshedExpiresAt = refresh ? new Date(now + appConfig.sessionTtlMs) : undefined;
    if (refresh || touch) await authRepository.updateSession({ id: sessionId, expiresAt: refreshedExpiresAt, lastSeenAt: new Date(now) });

    const keys = await authRepository.listUserPermissionKeys({ userId: user.id });
    return { ...user, permissions: keys.filter(isPermissionKey), refreshedExpiresAt };
  }

  async listSessions({ userId, token }: { userId: string; token: string }) {
    const current = hashToken(token);
    const rows = await authRepository.listActiveSessions({ userId });
    return rows.map(({ tokenHash, ...rest }) => ({ ...rest, current: tokenHash === current }));
  }

  async revokeSession({ userId, id }: { userId: string; id: string }) {
    if (!(await authRepository.deleteSession({ id, userId }))) throw new NotFoundError('Session not found');
  }

  revokeOtherSessions({ userId, token }: { userId: string; token: string }) {
    return authRepository.deleteOtherSessions({ userId, keepTokenHash: hashToken(token) });
  }

  async changePassword({ userId, organizationId, token, input }: { userId: string; organizationId: string; token: string; input: ChangePasswordInput }) {
    const stored = await authRepository.findPasswordHash({ userId });
    if (!stored || !(await verifyPassword(input.currentPassword, stored))) {
      throw new BadRequestError('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }
    const passwordHash = await hashPassword(input.newPassword);
    await withTransaction(async (tx) => {
      await authRepository.updatePasswordHash({ userId, passwordHash }, tx);
      await authRepository.deleteOtherSessions({ userId, keepTokenHash: hashToken(token) }, tx);
    });
    await audit({ organizationId, actorUserId: userId, action: 'user.password_changed', targetType: 'user', targetId: userId });
  }

  // Returns immediately; the lookup runs in the background so response time never reveals whether the email exists.
  forgotPassword({ email }: ForgotPasswordInput, ipAddress: string | null) {
    void this.issueResetTokens(email, ipAddress).catch((err: unknown) => logger.error({ err }, 'password reset request failed'));
  }

  // Email is unique per organization only, so every active account with this email gets its own link.
  private async issueResetTokens(email: string, ipAddress: string | null) {
    const matches = await authRepository.findActiveUsersByEmail({ email });
    for (const user of matches) {
      const { token, tokenHash } = generateResetToken();
      await withTransaction(async (tx) => {
        await authRepository.deleteUnusedResetTokens({ userId: user.id }, tx);
        await authRepository.createResetToken({ userId: user.id, tokenHash, expiresAt: new Date(Date.now() + appConfig.passwordResetTtlMs), ipAddress }, tx);
      });
      const link = `${env.APP_URL.replace(/\/+$/, '')}/reset-password?token=${token}`;
      const minutes = appConfig.passwordResetTtlMs / 60_000;
      // queueEmail logs a one-time warning when mail is not configured.
      await queueEmail({
        organizationId: user.organizationId,
        kind: 'password_reset',
        to: email,
        subject: `Reset your password for ${user.organizationName}`,
        html: `<p>${esc(`Hello ${user.fullName},`)}</p>
<p>We received a request to reset your password for your account at <strong>${esc(user.organizationName)}</strong>. <a href="${esc(link)}">Choose a new password</a>. The link is valid for ${minutes} minutes.</p>
<p>If you did not ask for this, you can ignore this email.</p>`,
        text: `Hello ${user.fullName},\n\nReset your password: ${link}\n\nThe link is valid for ${minutes} minutes. If you did not ask for this, ignore this email.`,
      });
      await audit({
        organizationId: user.organizationId,
        action: 'user.password_reset_requested',
        targetType: 'user',
        targetId: user.id,
        metadata: { ipAddress },
      });
    }
  }

  async resetPassword({ token, newPassword }: ResetPasswordInput) {
    const passwordHash = await hashPassword(newPassword);
    await withTransaction(async (tx) => {
      const row = await authRepository.findResetTokenForUpdate({ tokenHash: hashResetToken(token) }, tx);
      if (!row || !row.isActive || !isResetTokenUsable(row)) throw new BadRequestError('Invalid or expired reset link', 'INVALID_RESET_TOKEN');
      await authRepository.updatePasswordHash({ userId: row.userId, passwordHash }, tx);
      await authRepository.markResetTokenUsed({ id: row.id }, tx);
      await usersRepository.deleteSessions({ userId: row.userId }, tx);
      await audit({ organizationId: row.organizationId, action: 'user.password_reset_completed', targetType: 'user', targetId: row.userId }, tx);
    });
  }

  private async createSession(userId: string, meta: SessionMeta) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + appConfig.sessionTtlMs);
    await authRepository.createSession({ userId, tokenHash: hashToken(token), expiresAt, ...meta });
    return { token, expiresAt };
  }
}

export const authService = new AuthService();

// middleware/authenticate.ts imports this module as a namespace (`authService.getUserBySessionToken`).
export const getUserBySessionToken = (token: string) => authService.getUserBySessionToken(token);
