import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { deals, invoices, leads, orders, payments, pipelineStages, refunds } from '@/database/schema/index.js';
import { reportSchedules, savedReports } from '@/database/schema/reports.js';
import type { MonthlyEntry } from './reports.buckets.js';
import type { ResolvedRange } from './reports.validation.js';

const within = (column: AnyColumn, { start, end }: ResolvedRange) => and(gte(column, start), lt(column, end));
const num = (expr: ReturnType<typeof sql>) => expr.mapWith(Number);
const nullableNum = (v: unknown) => (v == null ? null : Number(v));

// Month bucket expressions; the format literal must stay inline (not a bind parameter) so select and group by match.
const monthOfDate = (col: AnyColumn) => sql<string>`to_char(${col}, 'YYYY-MM')`;
const monthOfTs = (col: AnyColumn) => sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM')`;

// Only grouped aggregates; nothing here loads whole tables.
class ReportsRepository {
  async revenueEntries({ organizationId, range }: { organizationId: string; range: ResolvedRange }): Promise<MonthlyEntry[]> {
    const invoiceMonth = monthOfDate(invoices.issueDate);
    const invoiced = await db
      .select({ month: invoiceMonth, currency: invoices.currency, value: num(sql`coalesce(sum(${invoices.totalMinor}), 0)`) })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          ne(invoices.status, 'void'),
          gte(invoices.issueDate, range.from),
          lt(invoices.issueDate, range.endDay),
        ),
      )
      .groupBy(invoiceMonth, invoices.currency);

    const paidMonth = monthOfTs(payments.paidAt);
    const paid = await db
      .select({ month: paidMonth, currency: invoices.currency, value: num(sql`coalesce(sum(${payments.amountMinor}), 0)`) })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(eq(payments.organizationId, organizationId), within(payments.paidAt, range)))
      .groupBy(paidMonth, invoices.currency);

    const refundMonth = monthOfTs(refunds.createdAt);
    const refunded = await db
      .select({ month: refundMonth, currency: invoices.currency, value: num(sql`coalesce(sum(${refunds.amountMinor}), 0)`) })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(eq(refunds.organizationId, organizationId), within(refunds.createdAt, range)))
      .groupBy(refundMonth, invoices.currency);

    const orderMonth = monthOfTs(orders.createdAt);
    const ordered = await db
      .select({ month: orderMonth, currency: orders.currency, n: count(), total: num(sql`coalesce(sum(${orders.totalMinor}), 0)`) })
      .from(orders)
      .where(and(eq(orders.organizationId, organizationId), ne(orders.status, 'cancelled'), within(orders.createdAt, range)))
      .groupBy(orderMonth, orders.currency);

    return [
      ...invoiced.map((r): MonthlyEntry => ({ ...r, field: 'invoicedMinor' })),
      ...paid.map((r): MonthlyEntry => ({ ...r, field: 'collectedMinor' })),
      ...refunded.map((r): MonthlyEntry => ({ ...r, field: 'collectedMinor', value: -r.value })),
      ...ordered.map((r): MonthlyEntry => ({ month: r.month, currency: r.currency, field: 'orderCount', value: r.n })),
      ...ordered.map((r): MonthlyEntry => ({ month: r.month, currency: r.currency, field: 'orderTotalMinor', value: r.total })),
    ];
  }

  // Current state per stage and currency; the age only makes sense for deals still open.
  async stageSnapshot({ organizationId }: { organizationId: string }) {
    const ageDays = sql`extract(epoch from (now() - ${deals.createdAt})) / 86400`;
    const rows = await db
      .select({
        stageId: pipelineStages.id,
        stage: pipelineStages.name,
        pipelineId: pipelineStages.pipelineId,
        kind: pipelineStages.kind,
        position: pipelineStages.position,
        currency: deals.currency,
        dealCount: count(deals.id),
        valueMinor: num(sql`coalesce(sum(${deals.valueMinor}), 0)`),
        avgAgeDays: sql`avg(${ageDays}) filter (where ${pipelineStages.kind} = 'open')`.mapWith(nullableNum),
      })
      .from(pipelineStages)
      .leftJoin(deals, and(eq(deals.stageId, pipelineStages.id), isNull(deals.deletedAt)))
      .where(eq(pipelineStages.organizationId, organizationId))
      .groupBy(pipelineStages.id, deals.currency)
      .orderBy(asc(pipelineStages.pipelineId), asc(pipelineStages.position));
    return rows;
  }

  // No closed-at column: a deal counts as closed in the window its row was last updated in (see the dashboard's dealsWon).
  async closedTotals({ organizationId, range }: { organizationId: string; range: ResolvedRange }) {
    const [row] = await db
      .select({
        won: num(sql`count(*) filter (where ${pipelineStages.kind} = 'won')`),
        lost: num(sql`count(*) filter (where ${pipelineStages.kind} = 'lost')`),
        avgDaysToWon: sql`avg(extract(epoch from (${deals.updatedAt} - ${deals.createdAt})) / 86400) filter (where ${pipelineStages.kind} = 'won')`.mapWith(
          nullableNum,
        ),
      })
      .from(deals)
      .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(
        and(eq(deals.organizationId, organizationId), isNull(deals.deletedAt), inArray(pipelineStages.kind, ['won', 'lost']), within(deals.updatedAt, range)),
      );
    return row ?? { won: 0, lost: 0, avgDaysToWon: null };
  }

  wonByCurrency({ organizationId, range }: { organizationId: string; range: ResolvedRange }) {
    return db
      .select({
        currency: deals.currency,
        count: count(),
        valueMinor: num(sql`coalesce(sum(${deals.valueMinor}), 0)`),
        avgValueMinor: num(sql`coalesce(round(avg(${deals.valueMinor})), 0)`),
      })
      .from(deals)
      .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(and(eq(deals.organizationId, organizationId), isNull(deals.deletedAt), eq(pipelineStages.kind, 'won'), within(deals.updatedAt, range)))
      .groupBy(deals.currency)
      .orderBy(asc(deals.currency));
  }

  leadsBy(column: 'status' | 'source', { organizationId, range }: { organizationId: string; range: ResolvedRange }) {
    const col = column === 'status' ? leads.status : leads.source;
    return db
      .select({ key: col, count: count() })
      .from(leads)
      .where(and(eq(leads.organizationId, organizationId), isNull(leads.deletedAt), within(leads.createdAt, range)))
      .groupBy(col)
      .orderBy(desc(count()), asc(col));
  }

  // ---- saved reports ----

  listSaved({ organizationId, userId }: { organizationId: string; userId: string }, executor: DbExecutor = db) {
    return executor
      .select()
      .from(savedReports)
      .where(and(eq(savedReports.organizationId, organizationId), eq(savedReports.ownerId, userId)))
      .orderBy(asc(savedReports.name));
  }

  async findSaved({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select()
      .from(savedReports)
      .where(and(eq(savedReports.organizationId, organizationId), eq(savedReports.ownerId, userId), eq(savedReports.id, id)))
      .limit(1);
    return row;
  }

  // Serialises concurrent creates for one user so the cap cannot be raced past.
  lockOwner(key: string, executor: DbExecutor = db) {
    return executor.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }

  async countSaved({ organizationId, userId }: { organizationId: string; userId: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ total: count() })
      .from(savedReports)
      .where(and(eq(savedReports.organizationId, organizationId), eq(savedReports.ownerId, userId)));
    return row?.total ?? 0;
  }

  async createSaved(values: typeof savedReports.$inferInsert, executor: DbExecutor = db) {
    const [row] = await executor.insert(savedReports).values(values).returning();
    return row;
  }

  async updateSaved({
    organizationId,
    userId,
    id,
    set,
  }: {
    organizationId: string;
    userId: string;
    id: string;
    set: Partial<typeof savedReports.$inferInsert>;
  }) {
    const [row] = await db
      .update(savedReports)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(savedReports.organizationId, organizationId), eq(savedReports.ownerId, userId), eq(savedReports.id, id)))
      .returning();
    return row;
  }

  async removeSaved({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }) {
    const rows = await db
      .delete(savedReports)
      .where(and(eq(savedReports.organizationId, organizationId), eq(savedReports.ownerId, userId), eq(savedReports.id, id)))
      .returning({ id: savedReports.id });
    return rows.length > 0;
  }

  // ---- schedules ----

  listSchedules({ organizationId, userId }: { organizationId: string; userId: string }) {
    return db
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.organizationId, organizationId), eq(reportSchedules.ownerId, userId)))
      .orderBy(asc(reportSchedules.nextRunAt));
  }

  async findSchedule({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }) {
    const [row] = await db
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.organizationId, organizationId), eq(reportSchedules.ownerId, userId), eq(reportSchedules.id, id)))
      .limit(1);
    return row;
  }

  async countSchedules({ organizationId, userId }: { organizationId: string; userId: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ total: count() })
      .from(reportSchedules)
      .where(and(eq(reportSchedules.organizationId, organizationId), eq(reportSchedules.ownerId, userId)));
    return row?.total ?? 0;
  }

  async createSchedule(values: typeof reportSchedules.$inferInsert, executor: DbExecutor = db) {
    const [row] = await executor.insert(reportSchedules).values(values).returning();
    return row;
  }

  async updateSchedule({
    organizationId,
    userId,
    id,
    set,
  }: {
    organizationId: string;
    userId: string;
    id: string;
    set: Partial<typeof reportSchedules.$inferInsert>;
  }) {
    const [row] = await db
      .update(reportSchedules)
      .set(set)
      .where(and(eq(reportSchedules.organizationId, organizationId), eq(reportSchedules.ownerId, userId), eq(reportSchedules.id, id)))
      .returning();
    return row;
  }

  async removeSchedule({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }) {
    const rows = await db
      .delete(reportSchedules)
      .where(and(eq(reportSchedules.organizationId, organizationId), eq(reportSchedules.ownerId, userId), eq(reportSchedules.id, id)))
      .returning({ id: reportSchedules.id });
    return rows.length > 0;
  }
}

export const reportsRepository = new ReportsRepository();
