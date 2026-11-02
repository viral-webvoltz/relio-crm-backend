import { describe, expect, it } from 'vitest';
import { mergeTimeline } from './timeline.merge.js';
import type { TimelineItem } from './timeline.merge.js';

const item = (type: string, iso: string, entityId = type): TimelineItem => ({
  type,
  at: new Date(iso),
  title: type,
  summary: null,
  entityType: type,
  entityId,
  actorName: null,
});

describe('mergeTimeline', () => {
  const a = [item('deal', '2026-01-03T00:00:00Z'), item('deal', '2026-01-01T00:00:00Z', 'd2')];
  const b = [item('task', '2026-01-02T00:00:00Z'), item('order', '2026-01-04T00:00:00Z')];

  it('merges sources newest first', () => {
    const { rows, total } = mergeTimeline([a, b], { page: 1, limit: 10 });
    expect(total).toBe(4);
    expect(rows.map((r) => r.type)).toEqual(['order', 'deal', 'task', 'deal']);
  });

  it('pages the merged list', () => {
    expect(mergeTimeline([a, b], { page: 2, limit: 3 }).rows).toHaveLength(1);
    expect(mergeTimeline([a, b], { page: 3, limit: 3 }).rows).toHaveLength(0);
  });

  it('orders ties deterministically', () => {
    const t = [item('task', '2026-01-01T00:00:00Z', 'b'), item('note', '2026-01-01T00:00:00Z', 'a')];
    expect(mergeTimeline([t], { page: 1, limit: 5 }).rows.map((r) => r.type)).toEqual(['note', 'task']);
  });
});
