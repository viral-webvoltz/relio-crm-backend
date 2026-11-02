import { sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { logger } from '@/shared/utils/logger.js';
import type { Values } from './workflows.conditions.js';

const MAX_VALUES_BYTES = 50_000;
const MAX_DEPTH_OF_VALUES = 4;
const MAX_STRING_WHEN_TRIMMED = 1_000;
const sensitiveKey = /password|token|secret|hash|authorization/i;

// What gets stored in the queue (and later in delayed jobs) is a copy of the record. Credentials never go in, and an oversized record
// is cut down to its top-level scalars, with long strings shortened, so one huge notes field cannot bloat the queue.
export function sanitizeValues(values: Values): Values {
  const clean = (value: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH_OF_VALUES) return undefined;
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => (sensitiveKey.test(k) ? [] : [[k, clean(v, depth + 1)] as const])));
    }
    return value;
  };
  const cleaned = clean(values, 0) as Values;
  if (JSON.stringify(cleaned).length <= MAX_VALUES_BYTES) return cleaned;
  return Object.fromEntries(
    Object.entries(cleaned).flatMap(([k, v]): [string, unknown][] => {
      if (typeof v === 'string') return [[k, v.slice(0, MAX_STRING_WHEN_TRIMMED)]];
      return v === null || typeof v === 'number' || typeof v === 'boolean' ? [[k, v]] : [];
    }),
  );
}

export type QueuedEvent = {
  organizationId: string;
  actorId: string;
  event: string;
  id: string | undefined; // the record the change touched
  values: Values;
  changed: string[];
  depth: number;
};

// One statement: the row is only written when the organization has an active workflow on this trigger, so the vast majority of
// requests (no workflows) cost one cheap indexed lookup. Never throws; a queue problem must not fail the request that produced the event.
export async function enqueueWorkflowEvent(ev: QueuedEvent): Promise<void> {
  try {
    await db.execute(sql`
      insert into workflow_events (organization_id, event, actor_id, record_id, values, changed, depth)
      select ${ev.organizationId}::uuid, ${ev.event}::text, ${ev.actorId}::uuid, ${ev.id ?? null}::uuid,
             ${JSON.stringify(sanitizeValues(ev.values))}::jsonb, ${JSON.stringify(ev.changed)}::jsonb, ${ev.depth}::int
      where exists (
        select 1 from workflows where organization_id = ${ev.organizationId}::uuid and trigger = ${ev.event}::text and is_active)`);
  } catch (err) {
    logger.error({ err, event: ev.event }, 'Failed to enqueue workflow event');
  }
}
