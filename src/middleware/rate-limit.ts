import type { Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '@/config/env.js';
import { TooManyRequestsError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/logger.js';
import { AuthLimiter } from './auth-limiter.js';
import { postgresCounterStore, purgeRateLimitCounters } from './rate-limit.store.js';

// ponytail: the per-IP limiters below are in-memory (per replica, reset on restart); the authenticated per-user/org limits are shared via Postgres.
// Behind a proxy set TRUST_PROXY (number of hops) so req.ip is the client, not the proxy.
const handler = (_req: unknown, _res: unknown, next: (err: Error) => void) => next(new TooManyRequestsError('Too many attempts, try again later'));
const base = { standardHeaders: 'draft-7', legacyHeaders: false, skip: () => env.NODE_ENV === 'test', handler } as const;

// Brute-force guard for credential endpoints, per IP.
export const authRateLimit = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 20 });

// Public links (a quote a customer opens from an email) have no session, so they are throttled per IP. A token is 256 random bits; this only stops floods.
export const publicLinkRateLimit = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 120 });

// Per target account: a distributed attack on one login is throttled even when every request comes from a new IP.
const bodyText = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
export const accountRateLimit = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `${bodyText(req.body?.organizationSlug)}|${bodyText(req.body?.email)}`,
  validate: { keyGeneratorIpFallback: false },
});

// Generous ceiling for everything else (including portal replies) so one client cannot flood the API or exhaust the DB pool.
export const apiRateLimit = rateLimit({ ...base, windowMs: 60 * 1000, limit: 600 });

// Authenticated limits, applied by `authenticate` once req.auth is known. Counted in Postgres by default, so every API instance
// shares one count; set RATE_LIMIT_STORE=memory to count per process instead (then N replicas allow up to N x the limit).
const minute = 60 * 1000;
let lastStoreWarning = 0;
const warnStoreFailure = (err: unknown) => {
  const now = Date.now();
  if (now - lastStoreWarning < minute) return; // one line per minute, not one per request
  lastStoreWarning = now;
  logger.warn({ err }, 'rate limit store unavailable, counting in memory');
};

const authLimiter = new AuthLimiter({
  userLimit: env.RATE_LIMIT_USER_PER_MIN,
  orgLimit: env.RATE_LIMIT_ORG_PER_MIN,
  windowSeconds: 60,
  ...(env.RATE_LIMIT_STORE === 'database' && { store: postgresCounterStore }),
  onStoreError: warnStoreFailure,
});

if (env.NODE_ENV !== 'test' && env.RATE_LIMIT_STORE === 'database') {
  setInterval(() => void purgeRateLimitCounters().catch((err: unknown) => logger.warn({ err }, 'rate limit purge failed')), minute).unref();
}

export async function enforceAuthLimits(res: Response, { userId, organizationId }: { userId: string; organizationId: string }) {
  if (env.NODE_ENV === 'test') return;
  const decision = await authLimiter.check(userId, organizationId);
  if (!decision) return;
  res.setHeader('RateLimit-Limit', String(decision.limit));
  res.setHeader('RateLimit-Remaining', String(decision.remaining));
  res.setHeader('RateLimit-Reset', String(decision.resetSeconds));
  if (decision.blocked) {
    res.setHeader('Retry-After', String(decision.resetSeconds));
    throw new TooManyRequestsError('Too many requests, try again later');
  }
}
