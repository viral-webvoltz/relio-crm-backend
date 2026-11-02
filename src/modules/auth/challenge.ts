import { createHmac, timingSafeEqual } from 'node:crypto';

// The short-lived pass handed out after a correct password for an account with two-factor on. It proves "the password was right a moment ago"
// and nothing else: it is not a session, and it is useless without a valid one-time code. Signed with the server secret, so it cannot be forged
// or edited, and it expires on its own.
export const CHALLENGE_TTL_MS = 5 * 60_000;

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(`2fa-challenge.${payload}`).digest('base64url');

export function issueChallenge(userId: string, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, exp: now + CHALLENGE_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

// The user id, or null for anything forged, edited or expired.
export function readChallenge(token: string, secret: string, now = Date.now()): string | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u?: unknown; exp?: unknown };
    return typeof u === 'string' && typeof exp === 'number' && exp > now ? u : null;
  } catch {
    return null;
  }
}
