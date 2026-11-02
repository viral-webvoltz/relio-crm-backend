import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { batchCompaniesSchema } from '@/modules/companies/companies.validation.js';
import { batchContactsSchema } from '@/modules/contacts/contacts.validation.js';
import { batchLeadsSchema } from '@/modules/leads/leads.validation.js';
import { batchProductsSchema } from '@/modules/products/products.validation.js';
import { batchTasksSchema } from '@/modules/tasks/tasks.validation.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import type { AuthContext } from '@/shared/types/auth.js';
import { assertBatchPermission, batchSchema, MAX_BATCH_SIZE, runBatch } from './index.js';

vi.mock('@/shared/utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
const schema = batchSchema(z.object({ a: z.string(), b: z.number() }).partial());
const id = crypto.randomUUID();

describe('batchSchema', () => {
  it('accepts delete and update', () => {
    expect(schema.safeParse({ action: 'delete', ids: [id] }).success).toBe(true);
    expect(schema.safeParse({ action: 'update', ids: [id], changes: { a: 'x' } }).success).toBe(true);
  });

  it('dedupes ids', () => {
    const r = schema.parse({ action: 'delete', ids: [id, id] });
    expect(r.ids).toEqual([id]);
  });

  it('rejects empty and over-limit ids', () => {
    expect(schema.safeParse({ action: 'delete', ids: [] }).success).toBe(false);
    expect(schema.safeParse({ action: 'delete', ids: ids(MAX_BATCH_SIZE) }).success).toBe(true);
    expect(schema.safeParse({ action: 'delete', ids: ids(MAX_BATCH_SIZE + 1) }).success).toBe(false);
  });

  it('rejects non-uuid ids and unknown actions', () => {
    expect(schema.safeParse({ action: 'delete', ids: ['nope'] }).success).toBe(false);
    expect(schema.safeParse({ action: 'archive', ids: [id] }).success).toBe(false);
  });

  it('rejects unknown change keys and empty changes', () => {
    expect(schema.safeParse({ action: 'update', ids: [id], changes: { a: 'x', evil: 1 } }).success).toBe(false);
    expect(schema.safeParse({ action: 'update', ids: [id], changes: {} }).success).toBe(false);
    expect(schema.safeParse({ action: 'update', ids: [id] }).success).toBe(false);
  });
});

describe('per-resource batch schemas accept only whitelisted fields', () => {
  const cases: [string, z.ZodType, Record<string, unknown>, Record<string, unknown>][] = [
    ['leads', batchLeadsSchema, { status: 'qualified', priority: 'high', assignedTo: id }, { firstName: 'x' }],
    ['tasks', batchTasksSchema, { status: 'open', priority: 'low', assignedTo: id, dueDate: '2026-01-01' }, { title: 'x' }],
    ['companies', batchCompaniesSchema, { industry: 'tech' }, { name: 'x' }],
    ['contacts', batchContactsSchema, { companyId: id }, { email: 'a@b.co' }],
    ['products', batchProductsSchema, { isActive: false, categoryId: id }, { priceMinor: 1 }],
  ];
  it.each(cases)('%s', (_name, sch, ok, bad) => {
    for (const [k, v] of Object.entries(ok)) {
      expect(sch.safeParse({ action: 'update', ids: [id], changes: { [k]: v } }).success, `${k} allowed`).toBe(true);
    }
    expect(sch.safeParse({ action: 'update', ids: [id], changes: bad }).success).toBe(false);
    expect(sch.safeParse({ action: 'update', ids: [id], changes: { ...ok, ...bad } }).success).toBe(false);
    expect(sch.safeParse({ action: 'delete', ids: [id] }).success).toBe(true);
  });
});

describe('runBatch', () => {
  it('reports partial failure, continues, and keeps order', async () => {
    const seen: string[] = [];
    const result = await runBatch(['1', '2', '3', '4'], async (x) => {
      seen.push(x);
      if (x === '2') throw new NotFoundError('gone');
      if (x === '3') throw new Error('boom: secret detail');
      if (x === '4') throw new ConflictError('busy', 'BUSY');
    });
    expect(seen).toEqual(['1', '2', '3', '4']);
    expect(result.succeeded).toEqual(['1']);
    expect(result.failed).toEqual([
      { id: '2', code: 'NOT_FOUND', message: 'gone' },
      { id: '3', code: 'INTERNAL_ERROR', message: 'Unexpected error' },
      { id: '4', code: 'BUSY', message: 'busy' },
    ]);
  });

  it('runs one at a time', async () => {
    let active = 0;
    let max = 0;
    await runBatch(['a', 'b', 'c'], async () => {
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(max).toBe(1);
  });
});

describe('assertBatchPermission', () => {
  const auth: AuthContext = { userId: 'u', organizationId: 'o', email: 'e', fullName: 'f', permissions: ['leads.update'] };
  it('throws ForbiddenError when missing', () => {
    expect(() => assertBatchPermission(auth, 'leads.delete')).toThrow(ForbiddenError);
  });
  it('passes when present', () => {
    expect(() => assertBatchPermission(auth, 'leads.update')).not.toThrow();
  });
});
