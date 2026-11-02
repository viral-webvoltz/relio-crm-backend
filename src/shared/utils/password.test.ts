import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { likeContains } from './like.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('still accepts legacy bcrypt hashes and flags them for upgrade', async () => {
    const legacy = await bcrypt.hash('old-password', 4);
    expect(await verifyPassword('old-password', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('likeContains', () => {
  it('escapes wildcards so they match literally', () => {
    expect(likeContains('50%_off')).toBe('%50\\%\\_off%');
  });
});
