import type { RequestHandler } from 'express';
import { z } from 'zod';
import { appConfig } from '@/config/app.config.js';
import { sessionCookieName } from '@/middleware/authenticate.js';
import { diffSnapshots, hasSnapshotLoader, loadSnapshot, type Snapshot } from '@/modules/audit/audit.snapshot.js';
import { auditService } from '@/modules/audit/audit.service.js';
import { enqueueWebhookEvent } from '@/modules/webhooks/webhooks.dispatcher.js';
import { enqueueWorkflowEvent } from '@/modules/workflows/workflows.events.js';
import type { AuthContext } from '@/shared/types/auth.js';

const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Personal or high-volume routes, plus customer-portal and login traffic (no staff actor, and bodies carry credentials).
const skippedEntities = new Set(['auth', 'portal', 'notifications', 'me', 'saved-views', 'audit-logs']);
// Already recorded with richer, named events by their services through audit(); logging them here too would duplicate every entry.
const explicitlyAudited = new Set(['users', 'roles', 'customers', 'payments', 'invoices/void', 'invoices/payments']);
const sensitiveKey = /password|token|secret|authorization/i;
const maxChangesBytes = 10_000;
const maxDepth = 6;

const defaultActions: Record<string, string> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
const uuid = z.uuid();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

function redact(value: unknown, depth = 0): unknown {
  if (depth > maxDepth) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  }
  return value;
}

function summariseChanges(body: unknown) {
  if (!isPlainObject(body) || Object.keys(body).length === 0) return null;
  const changes = redact(body);
  return JSON.stringify(changes).length > maxChangesBytes ? { truncated: true } : changes;
}

const idFromResponse = (body: unknown) => {
  if (!isPlainObject(body) || !isPlainObject(body.data)) return null;
  const parsed = uuid.safeParse(body.data.id);
  return parsed.success ? parsed.data : null;
};

const idFromParams = (params: unknown) => {
  if (!isPlainObject(params)) return null;
  const parsed = uuid.safeParse(params.id ?? params.contactId);
  return parsed.success ? parsed.data : null;
};

// Which stored record a request is about, for the before/after snapshot: the first uuid in the path of a route whose entity has a loader.
const snapshotTarget = (originalUrl: string) => {
  const path = (originalUrl.split('?')[0] ?? '').replace(appConfig.apiPrefix, '');
  const [entity, ...rest] = path.split('/').filter(Boolean);
  const id = rest.find((segment) => uuid.safeParse(segment).success);
  return entity && id && hasSnapshotLoader(entity) ? { entity, id } : null;
};

const safeSnapshot = async (entity: string, id: string): Promise<Snapshot | undefined> => {
  try {
    return await loadSnapshot(entity, id);
  } catch {
    return undefined; // the snapshot is a bonus; never let it break the request
  }
};

// Records every successful create/update/delete/action by a signed-in staff user: who, which route, which record, what they submitted, and
// (for records of the known entities) a before/after diff of the stored row. Mounted once, ahead of all routers.
export const auditTrail: RequestHandler = async (req, res, next) => {
  if (!mutatingMethods.has(req.method)) return next();

  // Auth has not run yet, so only requests that carry a session cookie pay for the extra read.
  const target = req.cookies?.[sessionCookieName] ? snapshotTarget(req.originalUrl) : null;
  const before = target ? await safeSnapshot(target.entity, target.id) : undefined;

  let responseId: string | null = null;
  const send = res.json.bind(res);
  res.json = (body) => {
    responseId = idFromResponse(body);
    return send(body);
  };

  res.on('finish', () => {
    void record();
  });

  const record = async () => {
    const auth: AuthContext | undefined = req.auth;
    if (!auth || res.statusCode >= 400 || res.locals.skipAudit === true) return;

    const path = (req.originalUrl.split('?')[0] ?? '').replace(appConfig.apiPrefix, '');
    const [entityType, ...rest] = path.split('/').filter(Boolean);
    if (!entityType || skippedEntities.has(entityType)) return;

    const subPath = rest.filter((segment) => !uuid.safeParse(segment).success).join('/');
    const validated: unknown = req.validated;
    const params = isPlainObject(validated) ? validated.params : undefined;

    const action = subPath || defaultActions[req.method] || req.method.toLowerCase();
    const targetId = idFromParams(params) ?? responseId;
    const changes = summariseChanges(req.body);
    const after = target && before ? await safeSnapshot(target.entity, target.id) : undefined;
    const diff = before && after ? diffSnapshots(before, after) : null;

    if (!explicitlyAudited.has(entityType) && !explicitlyAudited.has(`${entityType}/${subPath}`)) {
      void auditService.recordRequest({
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action,
        targetType: entityType,
        targetId,
        changes,
        diff,
        statusCode: res.statusCode,
        requestId: req.id === undefined ? undefined : String(req.id),
        ipAddress: req.ip,
        apiKeyId: auth.apiKeyId,
      });
    }

    // Outbound webhooks hang off the same observation: `<entity>.<action>`, e.g. leads.create, deals.stage, invoices.payments.
    // The payload carries the id and the (redacted) submitted fields, never the stored row.
    const event = `${entityType}.${action}`.toLowerCase().replace(/[^a-z0-9_.]+/g, '_');
    void enqueueWebhookEvent({
      organizationId: auth.organizationId,
      event,
      data: { id: targetId, actorId: auth.userId, changes },
    });

    // Workflows see the stored row (loaded here for creates too) overlaid with what was just submitted.
    const submitted = isPlainObject(req.body) ? req.body : {};
    const record = after ?? (targetId && hasSnapshotLoader(entityType) ? await safeSnapshot(entityType, targetId) : undefined);
    void enqueueWorkflowEvent({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      event,
      id: targetId ?? undefined,
      values: { ...record, ...submitted },
      changed: Object.keys(submitted),
      depth: 0,
    });
  };

  next();
};
