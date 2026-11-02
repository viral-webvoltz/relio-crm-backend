import type { Request, RequestHandler, Response } from 'express';
import { env } from '@/config/env.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import * as authService from '@/modules/auth/auth.service.js';
import { apiKeysService, KEY_PREFIX } from '@/modules/api-keys/api-keys.service.js';
import { enforceAuthLimits } from './rate-limit.js';

export const sessionCookieName = 'sid';

// SameSite=None so a frontend on another site (e.g. *.vercel.app) can use the cookie; browsers require Secure with None.
// csrfOrigin is the CSRF defence for that. Locally (non-production, http) fall back to Lax.
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: env.NODE_ENV === 'production' ? ('none' as const) : ('lax' as const),
  secure: env.NODE_ENV === 'production',
};

// The cookie must never outlive the session row's expiry.
export function setSessionCookie(res: Response, session: { token: string; expiresAt: Date }) {
  res.cookie(sessionCookieName, session.token, { ...sessionCookieOptions, expires: session.expiresAt });
}

// Resolves the session cookie to a trusted identity; organizationId and permissions always come from here, never from the client.
// A script can send `Authorization: Bearer crm_...` instead of a cookie. A cookie, when present, wins.
const bearerKey = (header: string | undefined) => (header?.startsWith('Bearer ') ? header.slice(7).trim() : null);

// Session token from the cookie, or from `Authorization: Bearer <token>` for a frontend that keeps it in localStorage (API keys start with crm_).
export const sessionTokenOf = (req: Pick<Request, 'cookies' | 'get'>): string | undefined => {
  const cookie: unknown = req.cookies?.[sessionCookieName];
  if (typeof cookie === 'string' && cookie) return cookie;
  const bearer = bearerKey(req.get('authorization'));
  return bearer && !bearer.startsWith(KEY_PREFIX) ? bearer : undefined;
};

export const authenticate: RequestHandler = async (req, res, next) => {
  const token = sessionTokenOf(req);
  if (!token) {
    const key = bearerKey(req.get('authorization'));
    const found = key ? await apiKeysService.authenticate(key) : null;
    if (!found) throw new UnauthorizedError();
    req.auth = {
      userId: found.userId,
      organizationId: found.organizationId,
      email: found.email,
      fullName: found.fullName,
      permissions: found.permissions,
      apiKeyId: found.keyId,
    };
    // Limits are counted per key, so a busy integration cannot use up its owner's allowance (or be throttled by it).
    await enforceAuthLimits(res, { userId: `key:${found.keyId}`, organizationId: found.organizationId });
    return next();
  }
  const user = await authService.getUserBySessionToken(token);
  if (!user) throw new UnauthorizedError();
  req.auth = {
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    fullName: user.fullName,
    permissions: user.permissions,
  };
  await enforceAuthLimits(res, req.auth);
  if (user.refreshedExpiresAt) setSessionCookie(res, { token, expiresAt: user.refreshedExpiresAt });
  next();
};
