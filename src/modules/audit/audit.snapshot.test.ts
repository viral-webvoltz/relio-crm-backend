import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/database.js', () => ({ db: {} }));

const { diffSnapshots, hasSnapshotLoader } = await import('./audit.snapshot.js');

describe('diffSnapshots', () => {
  it('returns only the fields that changed, with from and to', () => {
    const before = { id: 'a', title: 'Old', valueMinor: 100, stageId: 's1' };
    const after = { id: 'a', title: 'New', valueMinor: 100, stageId: 's2' };
    expect(diffSnapshots(before, after)).toEqual({ title: { from: 'Old', to: 'New' }, stageId: { from: 's1', to: 's2' } });
  });

  it('returns null when nothing but bookkeeping changed', () => {
    expect(diffSnapshots({ id: 'a', updatedAt: new Date('2026-01-01') }, { id: 'a', updatedAt: new Date('2026-02-01') })).toBeNull();
  });

  it('treats equal dates and equal objects as unchanged', () => {
    const when = '2026-03-01T00:00:00.000Z';
    expect(diffSnapshots({ at: new Date(when), meta: { a: 1 } }, { at: new Date(when), meta: { a: 1 } })).toBeNull();
  });

  it('serialises dates and shows a soft delete as deletedAt going from null to a time', () => {
    const diff = diffSnapshots({ deletedAt: null }, { deletedAt: new Date('2026-03-01T10:00:00Z') });
    expect(diff).toEqual({ deletedAt: { from: null, to: '2026-03-01T10:00:00.000Z' } });
  });

  it('never copies secret values, only flags that they changed', () => {
    const diff = diffSnapshots({ passwordHash: 'a', apiToken: 'x' }, { passwordHash: 'b', apiToken: 'y' });
    expect(diff).toEqual({ passwordHash: { from: '[redacted]', to: '[redacted]' }, apiToken: { from: '[redacted]', to: '[redacted]' } });
  });

  it('shortens very long strings and large objects', () => {
    const diff = diffSnapshots({ notes: 'a', blob: { a: 1 } }, { notes: 'x'.repeat(2000), blob: { list: 'y'.repeat(2000) } });
    expect(String(diff?.notes?.to).length).toBeLessThan(600);
    expect(diff?.blob?.to).toBe('[large value]');
  });

  it('collapses a huge diff into a summary marker', () => {
    const before = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, 'a'.repeat(400)]));
    const after = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, 'b'.repeat(400)]));
    expect(diffSnapshots(before, after)).toEqual({ _truncated: { from: null, to: '60 fields changed' } });
  });
});

describe('hasSnapshotLoader', () => {
  it('knows the audited entities and nothing else', () => {
    expect(hasSnapshotLoader('leads')).toBe(true);
    expect(hasSnapshotLoader('tickets')).toBe(true);
    expect(hasSnapshotLoader('users')).toBe(false);
  });
});
