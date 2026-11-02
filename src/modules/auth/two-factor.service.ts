import { and, count, eq, isNull } from 'drizzle-orm';
import { db, withTransaction, type DbTransaction } from '@/config/database.js';
import { env } from '@/config/env.js';
import { organizations, userRecoveryCodes, userTotp, users } from '@/database/schema/index.js';
import { BadRequestError, ConflictError, NotFoundError, TooManyRequestsError, UnauthorizedError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { verifyPassword } from '@/shared/utils/password.js';
import { authRepository } from './auth.repository.js';
import { issueChallenge, readChallenge } from './challenge.js';
import { open, seal } from './secret-box.js';
import { generateRecoveryCodes, generateSecret, hashRecoveryCode, otpauthUrl, verifyTotp } from './totp.js';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

type Factor = { code?: string | undefined; recoveryCode?: string | undefined };

class TwoFactorService {
  async isEnabled(userId: string): Promise<boolean> {
    const [row] = await db.select({ confirmedAt: userTotp.confirmedAt }).from(userTotp).where(eq(userTotp.userId, userId));
    return Boolean(row?.confirmedAt);
  }

  async status(userId: string) {
    const [row] = await db.select({ confirmedAt: userTotp.confirmedAt }).from(userTotp).where(eq(userTotp.userId, userId));
    const [left] = await db
      .select({ value: count() })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    return {
      enabled: Boolean(row?.confirmedAt),
      setupPending: Boolean(row && !row.confirmedAt),
      recoveryCodesRemaining: row?.confirmedAt ? (left?.value ?? 0) : 0,
    };
  }

  // Step 1: a fresh seed, stored but not yet active. Asking for the password again stops someone at an unlocked screen from enrolling their own phone.
  async setup({ userId, organizationId, email, password }: { userId: string; organizationId: string; email: string; password: string }) {
    await this.assertPassword(userId, password);
    if (await this.isEnabled(userId)) throw new ConflictError('Two-factor authentication is already on', 'TWO_FACTOR_ALREADY_ON');
    const secret = generateSecret();
    const sealed = seal(secret, env.JWT_SECRET);
    await db
      .insert(userTotp)
      .values({ userId, secretCiphertext: sealed })
      .onConflictDoUpdate({ target: userTotp.userId, set: { secretCiphertext: sealed, failedAttempts: 0, lockedUntil: null, lastUsedStep: null } });
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
    return { secret, otpauthUrl: otpauthUrl({ secret, issuer: org?.name ?? 'CRM', account: email }) };
  }

  // Step 2: the user proves the app shows the right codes. Only then does it switch on, and the recovery codes are shown once.
  // Other sessions are signed out: from now on a login needs the second factor.
  async enable({ userId, organizationId, code, keepTokenHash }: { userId: string; organizationId: string; code: string; keepTokenHash: string }) {
    const recoveryCodes = generateRecoveryCodes();
    const outcome = await withTransaction(async (tx) => {
      const row = await this.lock(tx, userId);
      if (!row) throw new BadRequestError('Start the setup first', 'TWO_FACTOR_NOT_STARTED');
      if (row.confirmedAt) throw new ConflictError('Two-factor authentication is already on', 'TWO_FACTOR_ALREADY_ON');
      if (row.lockedUntil && row.lockedUntil > new Date()) return 'locked' as const;
      const step = verifyTotp({ secret: open(row.secretCiphertext, env.JWT_SECRET), code });
      if (step === null) return this.recordFailure(tx, row);
      await tx.update(userTotp).set({ confirmedAt: new Date(), lastUsedStep: step, failedAttempts: 0, lockedUntil: null }).where(eq(userTotp.userId, userId));
      await this.replaceRecoveryCodes(tx, userId, recoveryCodes);
      await authRepository.deleteOtherSessions({ userId, keepTokenHash }, tx);
      await audit({ organizationId, actorUserId: userId, action: 'user.two_factor_enabled', targetType: 'user', targetId: userId }, tx);
      return 'ok' as const;
    });
    if (outcome !== 'ok') this.fail(outcome);
    return { recoveryCodes };
  }

  async disable({ userId, organizationId, password, factor }: { userId: string; organizationId: string; password: string; factor: Factor }) {
    await this.assertPassword(userId, password);
    await this.verify(userId, factor);
    await withTransaction(async (tx) => {
      await tx.delete(userTotp).where(eq(userTotp.userId, userId));
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
      await audit({ organizationId, actorUserId: userId, action: 'user.two_factor_disabled', targetType: 'user', targetId: userId }, tx);
    });
  }

  // A new set invalidates every old code.
  async regenerateRecoveryCodes({ userId, organizationId, password, code }: { userId: string; organizationId: string; password: string; code: string }) {
    await this.assertPassword(userId, password);
    await this.verify(userId, { code });
    const recoveryCodes = generateRecoveryCodes();
    await withTransaction(async (tx) => {
      await this.replaceRecoveryCodes(tx, userId, recoveryCodes);
      await audit({ organizationId, actorUserId: userId, action: 'user.recovery_codes_regenerated', targetType: 'user', targetId: userId }, tx);
    });
    return { recoveryCodes };
  }

  // For a lost phone and lost recovery codes: an administrator switches it off and the person signs in with just their password.
  async adminReset({ organizationId, actorId, targetUserId }: { organizationId: string; actorId: string; targetUserId: string }) {
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, targetUserId)));
    if (!target) throw new NotFoundError('User not found');
    await withTransaction(async (tx) => {
      await tx.delete(userTotp).where(eq(userTotp.userId, targetUserId));
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, targetUserId));
      await audit({ organizationId, actorUserId: actorId, action: 'user.two_factor_reset', targetType: 'user', targetId: targetUserId }, tx);
    });
  }

  // ---- signing in ----

  challengeFor(userId: string) {
    return issueChallenge(userId, env.JWT_SECRET);
  }

  // The user a valid challenge belongs to, once they also prove the second factor. Wrong codes count towards a lockout.
  async completeLogin({ challengeToken, factor }: { challengeToken: string; factor: Factor }): Promise<string> {
    const userId = readChallenge(challengeToken, env.JWT_SECRET);
    if (!userId) throw new UnauthorizedError('This sign-in has expired. Start again.', 'INVALID_CHALLENGE');
    const [user] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, userId));
    if (!user?.isActive) throw new UnauthorizedError('This sign-in has expired. Start again.', 'INVALID_CHALLENGE');
    await this.verify(userId, factor);
    return userId;
  }

  // ---- helpers ----

  // Checks an app code or a recovery code. The attempt is recorded even when it fails, which is why the outcome is returned out of the
  // transaction and only then turned into an error (an error inside would roll the failure count back).
  private async verify(userId: string, factor: Factor) {
    const outcome = await withTransaction(async (tx) => {
      const row = await this.lock(tx, userId);
      if (!row?.confirmedAt) return 'invalid' as const;
      if (row.lockedUntil && row.lockedUntil > new Date()) return 'locked' as const;

      if (factor.recoveryCode) {
        const used = await tx
          .update(userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(
            and(eq(userRecoveryCodes.userId, userId), eq(userRecoveryCodes.codeHash, hashRecoveryCode(factor.recoveryCode)), isNull(userRecoveryCodes.usedAt)),
          )
          .returning({ id: userRecoveryCodes.id });
        if (used.length === 0) return this.recordFailure(tx, row);
        await tx.update(userTotp).set({ failedAttempts: 0, lockedUntil: null }).where(eq(userTotp.userId, userId));
        return 'recovery' as const;
      }

      const step = verifyTotp({ secret: open(row.secretCiphertext, env.JWT_SECRET), code: factor.code ?? '', lastUsedStep: row.lastUsedStep });
      if (step === null) return this.recordFailure(tx, row);
      await tx.update(userTotp).set({ lastUsedStep: step, failedAttempts: 0, lockedUntil: null }).where(eq(userTotp.userId, userId));
      return 'ok' as const;
    });
    if (outcome !== 'ok' && outcome !== 'recovery') this.fail(outcome);
    return outcome;
  }

  private async recordFailure(tx: DbTransaction, row: typeof userTotp.$inferSelect) {
    const failures = row.failedAttempts + 1;
    const lock = failures >= MAX_FAILURES;
    await tx
      .update(userTotp)
      .set({ failedAttempts: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + LOCK_MS) : null })
      .where(eq(userTotp.userId, row.userId));
    return lock ? ('locked' as const) : ('invalid' as const);
  }

  private fail(outcome: 'invalid' | 'locked'): never {
    if (outcome === 'locked')
      throw new TooManyRequestsError('Too many wrong codes. Try again in 15 minutes, or use a recovery code from an administrator reset.');
    throw new UnauthorizedError('That code is not right', 'INVALID_CODE');
  }

  private async lock(tx: DbTransaction, userId: string) {
    const [row] = await tx.select().from(userTotp).where(eq(userTotp.userId, userId)).for('update');
    return row;
  }

  private async replaceRecoveryCodes(tx: DbTransaction, userId: string, codes: string[]) {
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx.insert(userRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
  }

  private async assertPassword(userId: string, password: string) {
    const stored = await authRepository.findPasswordHash({ userId });
    if (!stored || !(await verifyPassword(password, stored))) throw new BadRequestError('Password is incorrect', 'INVALID_PASSWORD');
  }
}

export const twoFactorService = new TwoFactorService();
