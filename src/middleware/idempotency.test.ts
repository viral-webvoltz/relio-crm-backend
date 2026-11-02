import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// A tiny in-memory stand-in for the drizzle chains idempotency.ts uses. eq/and are replaced by plain
// descriptors so the fake can read the (organization, user, key, id) a query targets.
type Row = {
  id: string;
  organizationId: string;
  userId: string;
  key: string;
  requestHash: string;
  statusCode: number | null;
  responseBody: unknown;
  createdAt: Date;
};
type Cond = { col: string; val: unknown };

const h = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  eq: (col: { name: string }, val: unknown): Cond => ({ col: col.name, val }),
  and: (...c: unknown[]) => c.flat(),
  lt: () => ({}),
}));

vi.mock('@/shared/utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

vi.mock('@/config/database.js', () => {
  const match = (where: unknown): Row[] => {
    const conds = (Array.isArray(where) ? where.flat(Infinity) : [where]) as Cond[];
    return h.rows.filter((r) =>
      conds.every((c) => {
        const field = { organization_id: 'organizationId', user_id: 'userId', key: 'key', id: 'id' }[c.col];
        return field !== undefined && r[field as keyof Row] === c.val;
      }),
    );
  };
  const db = {
    insert: () => ({
      values: (v: { organizationId: string; userId: string; key: string; requestHash: string }) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (h.rows.some((r) => r.organizationId === v.organizationId && r.userId === v.userId && r.key === v.key)) return [];
            const row: Row = { ...v, id: crypto.randomUUID(), statusCode: null, responseBody: null, createdAt: new Date() };
            h.rows.push(row);
            return [{ id: row.id }];
          },
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: async (w: unknown) => match(w).map((r) => ({ ...r })) }) }),
    delete: () => ({
      where: async (w: unknown) => {
        for (const r of match(w)) h.rows.splice(h.rows.indexOf(r), 1);
      },
    }),
    update: () => ({
      set: (v: Partial<Row>) => ({
        where: async (w: unknown) => {
          for (const r of match(w)) Object.assign(r, v);
        },
      }),
    }),
  };
  return { db };
});

const { idempotent } = await import('./idempotency.js');

const org = crypto.randomUUID();
const user = crypto.randomUUID();
const key = crypto.randomUUID();

function makeReq(opts: { key?: string; body?: unknown; url?: string } = {}) {
  const headers: Record<string, string | undefined> = { 'idempotency-key': opts.key };
  return {
    method: 'POST',
    originalUrl: opts.url ?? '/api/v1/leads',
    body: opts.body ?? { name: 'a' },
    auth: { organizationId: org, userId: user },
    header: (n: string) => headers[n.toLowerCase()],
  } as unknown as Request;
}

function makeRes() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    statusCode: 200,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json: (body: unknown) => {
      sent.body = body;
      sent.status = res.statusCode;
      return res;
    },
  };
  return { res: res as unknown as Response, sent, raw: res };
}

// Runs the handler, then simulates the downstream handler answering with `status`/`body`.
async function run(req: Request, answer?: { status: number; body: unknown }) {
  const { res, sent, raw } = makeRes();
  const next = vi.fn();
  await idempotent(req, res, next);
  if (answer && next.mock.calls.length > 0) {
    raw.statusCode = answer.status;
    res.json(answer.body);
    await vi.waitFor(() => expect(sent.body).toBeDefined());
  }
  return { sent, next, locals: raw.locals };
}

beforeEach(() => {
  h.rows.length = 0;
});

describe('idempotent middleware', () => {
  it('passes straight through without a header', async () => {
    const { next } = await run(makeReq());
    expect(next).toHaveBeenCalledOnce();
    expect(h.rows).toHaveLength(0);
  });

  it('rejects a non-uuid key', async () => {
    await expect(run(makeReq({ key: 'abc' }))).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY', statusCode: 400 });
  });

  it('claims the key, stores the 2xx body, and replays it without calling next', async () => {
    const first = await run(makeReq({ key }), { status: 201, body: { data: { id: 'x' } } });
    expect(first.next).toHaveBeenCalledOnce();
    expect(first.sent).toEqual({ status: 201, body: { data: { id: 'x' } } });
    expect(h.rows[0]).toMatchObject({ statusCode: 201, responseBody: { data: { id: 'x' } } });

    const replay = await run(makeReq({ key }));
    expect(replay.next).not.toHaveBeenCalled();
    expect(replay.sent).toEqual({ status: 201, body: { data: { id: 'x' } } });
    expect(replay.locals.skipAudit).toBe(true);
  });

  it('rejects the same key with a different body (422)', async () => {
    await run(makeReq({ key }), { status: 201, body: { ok: true } });
    await expect(run(makeReq({ key, body: { name: 'other' } }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 422 });
  });

  it('rejects the same key with a different path (422)', async () => {
    await run(makeReq({ key }), { status: 201, body: { ok: true } });
    await expect(run(makeReq({ key, url: '/api/v1/deals' }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('returns 409 while the original request is in flight', async () => {
    const first = await run(makeReq({ key })); // claimed, never answered
    expect(first.next).toHaveBeenCalledOnce();
    await expect(run(makeReq({ key }))).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS', statusCode: 409 });
  });

  it('takes over a stale in-flight claim', async () => {
    await run(makeReq({ key }));
    const row = h.rows[0];
    if (row) row.createdAt = new Date(Date.now() - 3 * 60 * 1000);
    const retry = await run(makeReq({ key }), { status: 201, body: { ok: 1 } });
    expect(retry.next).toHaveBeenCalledOnce();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]?.statusCode).toBe(201);
  });

  it('releases the key on a non-2xx response so the client can retry', async () => {
    await run(makeReq({ key }), { status: 422, body: { error: 'bad' } });
    expect(h.rows).toHaveLength(0);
    const retry = await run(makeReq({ key, body: { name: 'fixed' } }), { status: 201, body: { ok: true } });
    expect(retry.next).toHaveBeenCalledOnce();
    expect(h.rows[0]?.statusCode).toBe(201);
  });

  it('scopes keys per user: another user can reuse the same key', async () => {
    await run(makeReq({ key }), { status: 201, body: { ok: true } });
    const other = makeReq({ key });
    Object.assign(other, { auth: { organizationId: org, userId: crypto.randomUUID() } });
    const r = await run(other);
    expect(r.next).toHaveBeenCalledOnce();
  });
});
