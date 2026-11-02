import { createHash, randomBytes } from 'node:crypto';

export const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

// The raw token only goes into the email; the database keeps the hash.
export function generateResetToken() {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashResetToken(token) };
}

export const isResetTokenUsable = ({ expiresAt, usedAt }: { expiresAt: Date; usedAt: Date | null }, now = new Date()) =>
  usedAt === null && expiresAt.getTime() > now.getTime();
