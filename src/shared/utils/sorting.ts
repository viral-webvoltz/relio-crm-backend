import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { AppError } from '@/shared/errors/index.js';

type SortableColumns = Record<string, AnyColumn | SQL>;
export type SortQuery = { sort?: string | undefined; dir?: 'asc' | 'desc' | undefined };

// Sort fields are whitelisted per endpoint, so clients can never sort by (or probe) arbitrary columns.
// With no `sort`, the endpoint's default ordering is returned unchanged. The default also breaks ties.
export function orderByClause(allowed: SortableColumns, { sort, dir }: SortQuery, fallback: SQL[]): SQL[] {
  if (!sort) return fallback;
  const column = Object.hasOwn(allowed, sort) ? allowed[sort] : undefined;
  if (!column) throw new AppError(`Cannot sort by "${sort}"`, 400, 'INVALID_SORT');
  const direction = dir === 'desc' ? sql`desc` : sql`asc`;
  return [sql`${column} ${direction} nulls last`, ...fallback];
}

// Text priorities sort by meaning (low < medium < high), not alphabetically.
export const priorityRank = (column: AnyColumn) => sql`case ${column} when 'low' then 1 when 'medium' then 2 when 'high' then 3 else 0 end`;
