export const PER_SOURCE_CAP = 200;

export type TimelineItem = {
  type: string;
  at: Date;
  title: string;
  summary: string | null;
  entityType: string;
  entityId: string;
  actorName: string | null;
};

// Newest first; ties broken by type then id so paging is stable across requests.
const compare = (a: TimelineItem, b: TimelineItem) => b.at.getTime() - a.at.getTime() || a.type.localeCompare(b.type) || a.entityId.localeCompare(b.entityId);

// Each source is already capped, so the merged list holds at most sources * PER_SOURCE_CAP items.
export function mergeTimeline(sources: TimelineItem[][], { page, limit }: { page: number; limit: number }) {
  const all = sources.flat().sort(compare);
  const start = (page - 1) * limit;
  return { rows: all.slice(start, start + limit), total: all.length };
}
