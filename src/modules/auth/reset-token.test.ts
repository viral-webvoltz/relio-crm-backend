import { describe, expect, it } from 'vitest';
import { generateResetToken, hashResetToken, isResetTokenUsable } from './reset-token.js';

describe('reset token', () => {
  it('generates a 32-byte hex token and its sha-256 hash', () => {
    const a = generateResetToken();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).toBe(hashResetToken(a.token));
    expect(a.tokenHash).not.toBe(a.token);
    expect(generateResetToken().token).not.toBe(a.token);
  });

  it('rejects expired and used tokens', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const future = new Date('2026-01-01T12:30:00Z');
    const past = new Date('2026-01-01T11:59:00Z');
    expect(isResetTokenUsable({ expiresAt: future, usedAt: null }, now)).toBe(true);
    expect(isResetTokenUsable({ expiresAt: past, usedAt: null }, now)).toBe(false);
    expect(isResetTokenUsable({ expiresAt: now, usedAt: null }, now)).toBe(false);
    expect(isResetTokenUsable({ expiresAt: future, usedAt: past }, now)).toBe(false);
  });
});
