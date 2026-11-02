import { and, asc, count, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { companies, contacts, deals, invoices, leads, orders, payments, pipelineStages, refunds, tasks } from '@/database/schema/index.js';
import type { DateWindow } from './dashboard.validation.js';

const within = (column: AnyColumn, { start, end }: DateWindow) => and(gte(column, start), lt(column, end));

// Every method is a single aggregate (count/sum/group by) or a small limited list; nothing fetches whole tables.
class DashboardRepository {
  async taskTotals({ organizationId, userId }: { organizationId: string; userId: string }) {
    const [totals] = await db
      .select({ open: count(), overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < current_date)`.mapWith(Number) })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), eq(tasks.assignedTo, userId), eq(tasks.status, 'open'), isNull(tasks.deletedAt)));
    return { open: totals?.open ?? 0, overdue: totals?.overdue ?? 0 };
  }

  upcomingTasks({ organizationId, userId }: { organizationId: string; userId: string }) {
    return db
      .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, priority: tasks.priority })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), eq(tasks.assignedTo, userId), eq(tasks.status, 'open'), isNull(tasks.deletedAt)))
      .orderBy(sql`${tasks.dueDate} asc nulls last`)
      .limit(5);
  }

  // What is still owed, and how much of that is overdue, per currency. Both are "as of now"; money collected is range-based (see collected).
  invoiceTotals({ organizationId }: { organizationId: string }) {
    const unpaid = sql`${invoices.status} in ('unpaid', 'partial')`;
    const owed = sql`${invoices.totalMinor} - ${invoices.paidMinor}`;
    return db
      .select({
        currency: invoices.currency,
        outstandingMinor: sql<number>`coalesce(sum(${owed}) filter (where ${unpaid}), 0)`.mapWith(Number),
        overdueMinor: sql<number>`coalesce(sum(${owed}) filter (where ${unpaid} and ${invoices.dueDate} < current_date), 0)`.mapWith(Number),
        overdueCount: sql<number>`count(*) filter (where ${unpaid} and ${invoices.dueDate} < current_date)`.mapWith(Number),
      })
      .from(invoices)
      .where(eq(invoices.organizationId, organizationId))
      .groupBy(invoices.currency);
  }

  recentOrders({ organizationId, window }: { organizationId: string; window: DateWindow }) {
    return db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        status: orders.status,
        totalMinor: orders.totalMinor,
        currency: orders.currency,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(eq(orders.organizationId, organizationId), within(orders.createdAt, window)))
      .orderBy(desc(orders.orderNumber))
      .limit(5);
  }

  async contactCount({ organizationId }: { organizationId: string }) {
    const [row] = await db
      .select({ value: count() })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), isNull(contacts.deletedAt)));
    return row?.value ?? 0;
  }

  async companyCount({ organizationId }: { organizationId: string }) {
    const [row] = await db
      .select({ value: count() })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), isNull(companies.deletedAt)));
    return row?.value ?? 0;
  }

  async leadTotals({ organizationId, window }: { organizationId: string; window: DateWindow }) {
    const [totals] = await db
      .select({ total: count(), converted: sql<number>`count(*) filter (where ${leads.status} = 'converted')`.mapWith(Number) })
      .from(leads)
      .where(and(eq(leads.organizationId, organizationId), isNull(leads.deletedAt), within(leads.createdAt, window)));
    return { total: totals?.total ?? 0, converted: totals?.converted ?? 0 };
  }

  leadsBySource({ organizationId, window }: { organizationId: string; window: DateWindow }) {
    return db
      .select({ source: leads.source, count: count() })
      .from(leads)
      .where(and(eq(leads.organizationId, organizationId), isNull(leads.deletedAt), within(leads.createdAt, window)))
      .groupBy(leads.source)
      .orderBy(desc(count()));
  }

  recentLeads({ organizationId, window }: { organizationId: string; window: DateWindow }) {
    return db
      .select({ id: leads.id, firstName: leads.firstName, lastName: leads.lastName, status: leads.status, source: leads.source, createdAt: leads.createdAt })
      .from(leads)
      .where(and(eq(leads.organizationId, organizationId), isNull(leads.deletedAt), within(leads.createdAt, window)))
      .orderBy(desc(leads.createdAt))
      .limit(5);
  }

  // There is no closed-at column, so a deal counts as won in the window its row was last updated in (moving it to Won is normally the last edit).
  // ponytail: a later edit to a won deal shifts it to that window; add deals.closed_at if that matters.
  dealsWon({ organizationId, window }: { organizationId: string; window: DateWindow }) {
    return db
      .select({ currency: deals.currency, count: count(), valueMinor: sql<number>`coalesce(sum(${deals.valueMinor}), 0)`.mapWith(Number) })
      .from(deals)
      .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(and(eq(deals.organizationId, organizationId), eq(pipelineStages.kind, 'won'), isNull(deals.deletedAt), within(deals.updatedAt, window)))
      .groupBy(deals.currency);
  }

  ordersCreated({ organizationId, window }: { organizationId: string; window: DateWindow }) {
    return db
      .select({ currency: orders.currency, count: count(), totalMinor: sql<number>`coalesce(sum(${orders.totalMinor}), 0)`.mapWith(Number) })
      .from(orders)
      .where(and(eq(orders.organizationId, organizationId), ne(orders.status, 'cancelled'), within(orders.createdAt, window)))
      .groupBy(orders.currency);
  }

  // Payments received in the window and refunds issued in it, per currency (the invoice's currency); the caller nets them.
  async collected({ organizationId, window }: { organizationId: string; window: DateWindow }) {
    const sum = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
    const [paid, refunded] = await Promise.all([
      db
        .select({ currency: invoices.currency, amount: sum(payments.amountMinor) })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(and(eq(payments.organizationId, organizationId), within(payments.paidAt, window)))
        .groupBy(invoices.currency),
      db
        .select({ currency: invoices.currency, amount: sum(refunds.amountMinor) })
        .from(refunds)
        .innerJoin(payments, eq(payments.id, refunds.paymentId))
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(and(eq(refunds.organizationId, organizationId), within(refunds.createdAt, window)))
        .groupBy(invoices.currency),
    ]);
    return { paid, refunded };
  }

  dealsByStage({ organizationId }: { organizationId: string }) {
    return db
      .select({
        stageId: pipelineStages.id,
        stage: pipelineStages.name,
        kind: pipelineStages.kind,
        currency: deals.currency,
        count: count(deals.id),
        valueMinor: sql<number>`coalesce(sum(${deals.valueMinor}), 0)`.mapWith(Number),
      })
      .from(pipelineStages)
      .leftJoin(deals, and(eq(deals.stageId, pipelineStages.id), isNull(deals.deletedAt)))
      .where(eq(pipelineStages.organizationId, organizationId))
      .groupBy(pipelineStages.id, deals.currency)
      .orderBy(asc(pipelineStages.position));
  }
}

export const dashboardRepository = new DashboardRepository();
