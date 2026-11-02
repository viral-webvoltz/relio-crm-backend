import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ record: vi.fn(), enqueue: vi.fn() }));
vi.mock('@/modules/audit/audit.service.js', () => ({ auditService: { recordRequest: h.record } }));
vi.mock('@/modules/webhooks/webhooks.dispatcher.js', () => ({ enqueueWebhookEvent: h.enqueue }));

const { auditTrail } = await import('./audit-trail.js');

const auth = { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), email: 'e', fullName: 'f', permissions: [] };
const recordId = crypto.randomUUID();

type Opts = {
  method?: string;
  url?: string;
  body?: unknown;
  status?: number;
  auth?: typeof auth | undefined;
  skipAudit?: boolean;
  params?: unknown;
  respond?: unknown;
};

// Drives the middleware like Express would: handler runs, responds via res.json, then 'finish' fires.
function drive(o: Opts = {}) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: o.status ?? 200,
    locals: o.skipAudit ? { skipAudit: true } : {},
    json: (b: unknown) => b,
  });
  const req = {
    method: o.method ?? 'POST',
    originalUrl: o.url ?? '/api/v1/leads',
    body: o.body,
    auth: 'auth' in o ? o.auth : auth,
    validated: o.params ? { params: o.params } : undefined,
    id: 'req-1',
    ip: '1.2.3.4',
  } as unknown as Request;
  const next = vi.fn();
  auditTrail(req, res as unknown as Response, next);
  expect(next).toHaveBeenCalledOnce();
  res.json(o.respond ?? { data: { id: recordId } });
  res.emit('finish');
}

beforeEach(() => {
  h.record.mockReset();
  h.enqueue.mockReset();
});

describe('auditTrail', () => {
  it('records a successful create with the response id and a webhook event', () => {
    drive({ body: { firstName: 'A' } });
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'create',
        targetType: 'leads',
        targetId: recordId,
        changes: { firstName: 'A' },
        statusCode: 200,
        ipAddress: '1.2.3.4',
      }),
    );
    expect(h.enqueue).toHaveBeenCalledWith({
      organizationId: auth.organizationId,
      event: 'leads.create',
      data: { id: recordId, actorId: auth.userId, changes: { firstName: 'A' } },
    });
  });

  it('uses the sub-path as the action and the param id as target', () => {
    const id = crypto.randomUUID();
    drive({ url: `/api/v1/deals/${id}/stage?x=1`, params: { id }, respond: {} });
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'stage', targetType: 'deals', targetId: id }));
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ event: 'deals.stage' }));
  });

  it('maps PATCH and DELETE to update/delete', () => {
    drive({ method: 'PATCH', url: `/api/v1/leads/${recordId}` });
    drive({ method: 'DELETE', url: `/api/v1/leads/${recordId}` });
    expect(h.record.mock.calls.map((c) => c[0].action)).toEqual(['update', 'delete']);
  });

  it('redacts password/token/secret/authorization keys at any depth', () => {
    drive({ body: { password: 'p', newPassword: 'p2', nested: { apiToken: 't', list: [{ clientSecret: 's', Authorization: 'a', ok: 1 }] }, name: 'n' } });
    const changes = h.record.mock.calls[0]?.[0].changes;
    expect(changes).toEqual({
      password: '[redacted]',
      newPassword: '[redacted]',
      nested: { apiToken: '[redacted]', list: [{ clientSecret: '[redacted]', Authorization: '[redacted]', ok: 1 }] },
      name: 'n',
    });
    expect(JSON.stringify(h.enqueue.mock.calls[0]?.[0])).not.toMatch(/"p"|"t"|"s"|"a"/);
  });

  it('null changes for an empty body; truncated marker for a huge one', () => {
    drive({ body: {} });
    drive({ body: { blob: 'x'.repeat(11_000) } });
    expect(h.record.mock.calls[0]?.[0].changes).toBeNull();
    expect(h.record.mock.calls[1]?.[0].changes).toEqual({ truncated: true });
  });

  it.each(['auth', 'portal', 'notifications', 'me', 'saved-views', 'audit-logs'])('skips %s entirely (no audit, no webhook)', (entity) => {
    drive({ url: `/api/v1/${entity}/thing` });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/v1/users', 'users.create'],
    [`/api/v1/roles/${recordId}`, 'roles.create'],
    ['/api/v1/customers', 'customers.create'],
    ['/api/v1/payments', 'payments.create'],
    [`/api/v1/invoices/${recordId}/void`, 'invoices.void'],
    [`/api/v1/invoices/${recordId}/payments`, 'invoices.payments'],
  ])('explicitly audited %s: no audit row, still a webhook (%s)', (url, event) => {
    drive({ url, respond: {} });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ event }));
  });

  it('does not treat other invoice routes as explicitly audited', () => {
    drive({ url: '/api/v1/invoices' });
    expect(h.record).toHaveBeenCalledOnce();
  });

  it('ignores GET', () => {
    drive({ method: 'GET' });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('ignores 4xx/5xx responses', () => {
    drive({ status: 400 });
    drive({ status: 500 });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('respects res.locals.skipAudit (idempotent replay)', () => {
    drive({ skipAudit: true });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('ignores unauthenticated requests', () => {
    drive({ auth: undefined });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
