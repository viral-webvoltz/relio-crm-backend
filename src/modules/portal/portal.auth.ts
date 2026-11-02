import { randomBytes } from 'node:crypto';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from '@/shared/utils/password.js';
import { appConfig } from '@/config/app.config.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { hashToken } from '@/modules/auth/auth.service.js';
import { portalRepository } from './portal.repository.js';
import type { CustomerLoginInput } from './portal.validation.js';

export async function loginCustomer(input: CustomerLoginInput) {
  const row = await portalRepository.findLoginAccount(input.organizationSlug, input.email);

  const isValid = await verifyPassword(input.password, row?.account.passwordHash ?? (await dummyHash()));
  if (!row || !isValid || !row.account.isActive) {
    throw new UnauthorizedError('Invalid email, password or organization', 'INVALID_CREDENTIALS');
  }

  if (needsRehash(row.account.passwordHash)) await portalRepository.updatePasswordHash(row.account.id, await hashPassword(input.password));
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + appConfig.sessionTtlMs);
  await portalRepository.insertSession({ customerAccountId: row.account.id, tokenHash: hashToken(token), expiresAt });
  await portalRepository.touchLastLogin(row.account.id);
  return { token, expiresAt };
}

export async function logoutCustomer(token: string) {
  await portalRepository.deleteSessionByTokenHash(hashToken(token));
}

// The returned ids come from the database via the session, so everything the portal scopes on is server-decided.
export async function getCustomerBySessionToken(token: string) {
  return (await portalRepository.findCustomerBySessionTokenHash(hashToken(token))) ?? null;
}

export type AuthCustomer = NonNullable<Awaited<ReturnType<typeof getCustomerBySessionToken>>>;
