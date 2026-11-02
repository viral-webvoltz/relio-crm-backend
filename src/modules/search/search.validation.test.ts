import { describe, expect, it } from 'vitest';
import { searchPatterns, searchQuerySchema } from './search.validation.js';

describe('searchQuerySchema', () => {
  it('trims q and defaults types and limit', () => {
    const r = searchQuerySchema.parse({ q: '  ann  ' });
    expect(r).toEqual({ q: 'ann', types: ['contacts', 'leads', 'companies', 'deals'], limit: 5 });
  });

  it('rejects short, long and untrimmed-short terms', () => {
    expect(searchQuerySchema.safeParse({ q: ' a ' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });

  it('parses and dedupes types, rejects unknown ones', () => {
    expect(searchQuerySchema.parse({ q: 'ab', types: 'deals, leads,deals' }).types).toEqual(['deals', 'leads']);
    expect(searchQuerySchema.safeParse({ q: 'ab', types: 'users' }).success).toBe(false);
  });

  it('bounds limit', () => {
    expect(searchQuerySchema.safeParse({ q: 'ab', limit: '11' }).success).toBe(false);
    expect(searchQuerySchema.parse({ q: 'ab', limit: '10' }).limit).toBe(10);
  });
});

describe('searchPatterns', () => {
  it('escapes wildcards and builds contains/prefix', () => {
    expect(searchPatterns('50%_a\\')).toEqual({ contains: '%50\\%\\_a\\\\%', prefix: '50\\%\\_a\\\\%' });
  });
});
