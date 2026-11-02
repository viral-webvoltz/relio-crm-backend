import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/shared/errors/index.js';
import { orderByClause } from './sorting.js';

const allowed = { name: sql`name`, score: sql`score` };
const fallback = [sql`created_at desc`];

describe('orderByClause', () => {
  it('returns the default ordering when no sort is requested', () => {
    expect(orderByClause(allowed, {}, fallback)).toBe(fallback);
  });

  it('puts the requested column first and keeps the default as tie-breaker', () => {
    expect(orderByClause(allowed, { sort: 'name', dir: 'desc' }, fallback)).toHaveLength(2);
  });

  it('rejects fields that are not whitelisted', () => {
    expect(() => orderByClause(allowed, { sort: 'password_hash' }, fallback)).toThrow(AppError);
    expect(() => orderByClause(allowed, { sort: 'password_hash' }, fallback)).toThrow(/Cannot sort by/);
  });
});
