import { sql } from 'drizzle-orm';
import { withTransaction } from '@/config/database.js';
import { env } from '@/config/env.js';
import { removeRelatedRecords, type RelatedType } from '@/modules/activities/activities.related.js';
import { audit } from '@/shared/utils/audit.js';
import { logger } from '@/shared/utils/logger.js';
import { purgeCutoff } from './trash-purge.cutoff.js';

const BATCH = 200;
const FIRST_RUN_MS = 60_000;
const EVERY_MS = 6 * 60 * 60_000;

// `related`: activities/tasks point at these without a foreign key, so they are removed with the record.
// Products referenced by order items (restrict FK) are skipped.
const tables: { name: string; related?: RelatedType; extra?: ReturnType<typeof sql> }[] = [
  { name: 'leads', related: 'lead' },
  { name: 'contacts', related: 'contact' },
  { name: 'companies', related: 'company' },
  { name: 'deals', related: 'deal' },
  { name: 'tasks' },
  { name: 'products', extra: sql`and not exists (select 1 from order_items oi where oi.product_id = t.id)` },
];

type Row = { id: string; organization_id: string };

async function purgeTable({ name, related, extra }: (typeof tables)[number], cutoff: Date) {
  const perOrg = new Map<string, number>();
  const table = sql.identifier(name);
  for (;;) {
    const deleted = await withTransaction(async (tx) => {
      const { rows } = await tx.execute<Row>(
        sql`select t.id, t.organization_id from ${table} t where t.deleted_at < ${cutoff.toISOString()}::timestamptz ${extra ?? sql``} order by t.deleted_at limit ${BATCH}`,
      );
      if (rows.length === 0) return 0;
      if (related) for (const row of rows) await removeRelatedRecords(row.organization_id, related, row.id, tx);
      const ids = sql.join(
        rows.map((r) => sql`${r.id}::uuid`),
        sql`, `,
      );
      await tx.execute(sql`delete from ${table} where id in (${ids})`);
      for (const row of rows) perOrg.set(row.organization_id, (perOrg.get(row.organization_id) ?? 0) + 1);
      return rows.length;
    });
    if (deleted < BATCH) break; // a failing batch throws out of the loop, so a stuck row cannot spin forever
  }
  for (const [organizationId, purged] of perOrg) {
    await audit({ organizationId, action: 'trash.purged', targetType: 'system', metadata: { table: name, count: purged } });
  }
  return [...perOrg.values()].reduce((a, b) => a + b, 0);
}

export async function purgeTrash(now = new Date()) {
  const cutoff = purgeCutoff(env.TRASH_RETENTION_DAYS, now);
  for (const table of tables) {
    try {
      const count = await purgeTable(table, cutoff);
      if (count > 0) logger.info({ table: table.name, count }, 'Trash purged');
    } catch (err) {
      logger.error({ err, table: table.name }, 'Trash purge failed for table');
    }
  }
}

export function startTrashPurger(): () => void {
  const run = () => void purgeTrash().catch((err) => logger.error({ err }, 'Trash purge failed'));
  const first = setTimeout(run, FIRST_RUN_MS);
  const every = setInterval(run, EVERY_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
