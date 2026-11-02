import { describe, expect, it } from 'vitest';
import { purgeCutoff } from './trash-purge.cutoff.js';

describe('purgeCutoff', () => {
  it('goes back the retention days', () => {
    expect(purgeCutoff(30, new Date('2026-03-31T12:00:00Z')).toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(purgeCutoff(1, new Date('2026-01-02T00:00:00Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
