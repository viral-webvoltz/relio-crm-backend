import { describe, expect, it } from 'vitest';
import { CHALLENGE_TTL_MS, issueChallenge, readChallenge } from './challenge.js';

const secret = 's'.repeat(40);
const user = '0b9a7c1e-2c1b-4f0e-9b7a-1f2e3d4c5b6a';

describe('login challenge', () => {
  it('identifies the user until it expires', () => {
    const now = 1_000_000;
    const token = issueChallenge(user, secret, now);
    expect(readChallenge(token, secret, now + 1000)).toBe(user);
    expect(readChallenge(token, secret, now + CHALLENGE_TTL_MS - 1)).toBe(user);
    expect(readChallenge(token, secret, now + CHALLENGE_TTL_MS + 1)).toBeNull();
  });

  it('refuses a token signed with another key, an edited one and garbage', () => {
    const token = issueChallenge(user, secret);
    expect(readChallenge(token, 'x'.repeat(40))).toBeNull();

    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: '11111111-2222-4333-8444-555555555555', exp: Date.now() + 60_000 })).toString('base64url');
    expect(readChallenge(`${forged}.${signature}`, secret)).toBeNull(); // someone else's id under this signature
    expect(readChallenge(`${payload}.${signature}.extra`, secret)).toBeNull();
    for (const bad of ['', 'abc', '.', 'a.b', `${payload}.`]) expect(readChallenge(bad, secret)).toBeNull();
  });
});
