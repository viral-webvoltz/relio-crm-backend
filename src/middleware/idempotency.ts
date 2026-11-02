import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { db } from '@/config/database.js';
import { idempotencyKeys } from '@/database/schema/index.js';
import { BadRequestError, ConflictError, UnprocessableEntityError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/logger.js';

const ttlMs = 24 * 60 * 60 * 1000;
// A claimed key whose request never finished (process crash) is released after this long.
const staleInFlightMs = 2 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashRequest = (req: Parameters<RequestHandler>[0]) =>
  createHash('sha256')
    .update(`${req.method}\n${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`)
    .digest('hex');

// Opt-in per route: without an Idempotency-Key header the request runs as normal.
// Only 2xx responses are remembered; a failed attempt releases the key so the client can fix the form and retry with the same key.
export const idempotent: RequestHandler = async (req, res, next) => {
  const header = req.header('idempotency-key');
  if (!header) return next();
  if (!uuidPattern.test(header)) throw new BadRequestError('Idempotency-Key must be a UUID', 'INVALID_IDEMPOTENCY_KEY');

  const { organizationId, userId } = req.auth;
  const scope = and(eq(idempotencyKeys.organizationId, organizationId), eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, header));
  const requestHash = hashRequest(req);

  const claim = () =>
    db
      .insert(idempotencyKeys)
      .values({ organizationId, userId, key: header, method: req.method, path: req.originalUrl, requestHash })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });

  let claimed = await claim();
  if (claimed.length === 0) {
    const [existing] = await db.select().from(idempotencyKeys).where(scope);
    if (existing) {
      const ageMs = Date.now() - existing.createdAt.getTime();
      const stale = ageMs > ttlMs || (existing.statusCode === null && ageMs > staleInFlightMs);
      if (!stale) {
        if (existing.requestHash !== requestHash)
          throw new UnprocessableEntityError('Idempotency-Key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED');
        if (existing.statusCode === null) throw new ConflictError('The original request is still being processed', 'REQUEST_IN_PROGRESS');
        // The original request was already audited; a replay changes nothing.
        res.locals.skipAudit = true;
        res.status(existing.statusCode).json(existing.responseBody);
        return;
      }
      await db.delete(idempotencyKeys).where(and(scope, eq(idempotencyKeys.id, existing.id)));
    }
    claimed = await claim();
    if (claimed.length === 0) throw new ConflictError('The original request is still being processed', 'REQUEST_IN_PROGRESS');
  }

  // Persist the outcome before the response goes out, so a retry right after never sees an unfinished row.
  const send = res.json.bind(res);
  res.json = (body) => {
    const saved =
      res.statusCode >= 200 && res.statusCode < 300
        ? db.update(idempotencyKeys).set({ statusCode: res.statusCode, responseBody: body }).where(scope)
        : db.delete(idempotencyKeys).where(scope);
    void saved.catch((err: unknown) => logger.error({ err }, 'failed to settle idempotency key')).finally(() => send(body));
    return res;
  };
  next();
};

export const purgeExpiredIdempotencyKeys = () => db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - ttlMs)));
