import { and, asc, count, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db, type DbExecutor } from '@/config/database.js';
import { invoiceSequences, invoices, orderItems, orders, payments, refunds, users } from '@/database/schema/index.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import type { InvoiceListQuery } from './invoices.validation.js';

type NewInvoice = typeof invoices.$inferInsert;
type NewPayment = typeof payments.$inferInsert;
type NewRefund = typeof refunds.$inferInsert;

const invoiceScope = (organizationId: string, id: string) => and(eq(invoices.organizationId, organizationId), eq(invoices.id, id));
const sumOf = (column: typeof payments.amountMinor | typeof refunds.amountMinor) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

function listWhere(organizationId: string, { search, status, orderId }: InvoiceListQuery) {
  const isNumber = search && /^(inv-?)?\d+$/i.test(search);
  const statusFilter =
    status === 'overdue'
      ? and(inArray(invoices.status, ['unpaid', 'partial']), sql`${invoices.dueDate} < current_date`)
      : status
        ? eq(invoices.status, status)
        : undefined;
  const searchFilter = !search
    ? undefined
    : isNumber
      ? eq(invoices.invoiceNumber, Number(search.replace(/\D/g, '')))
      : ilike(invoices.customerName, likeContains(search));
  return and(eq(invoices.organizationId, organizationId), statusFilter, searchFilter, orderId ? eq(invoices.orderId, orderId) : undefined);
}

class InvoicesRepository {
  // Shared lock on the order so it cannot be cancelled while it is being invoiced.
  async findOrderForInvoice({ organizationId, orderId }: { organizationId: string; orderId: string }, executor: DbExecutor = db) {
    const [order] = await executor
      .select({ id: orders.id, status: orders.status, customerName: orders.customerName, currency: orders.currency, totalMinor: orders.totalMinor })
      .from(orders)
      .where(and(eq(orders.organizationId, organizationId), eq(orders.id, orderId)))
      .for('share');
    return order;
  }

  async findLiveInvoiceIdByOrder({ organizationId, orderId }: { organizationId: string; orderId: string }, executor: DbExecutor = db) {
    const [live] = await executor
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.orderId, orderId), ne(invoices.status, 'void')));
    return live;
  }

  // Same gap-free counter pattern as orders: the upsert locks the row until commit.
  async nextInvoiceNumber({ organizationId }: { organizationId: string }, executor: DbExecutor = db) {
    const [sequence] = await executor
      .insert(invoiceSequences)
      .values({ organizationId, lastNumber: 1 })
      .onConflictDoUpdate({ target: invoiceSequences.organizationId, set: { lastNumber: sql`${invoiceSequences.lastNumber} + 1` } })
      .returning();
    return sequence!.lastNumber;
  }

  async create({ values }: { values: NewInvoice }, executor: DbExecutor = db) {
    const [invoice] = await executor.insert(invoices).values(values).returning();
    return invoice!;
  }

  async list({ organizationId, query }: { organizationId: string; query: InvoiceListQuery }) {
    const { page, limit, sort, dir } = query;
    const rows = await db
      .select({ invoice: invoices, orderNumber: orders.orderNumber })
      .from(invoices)
      .innerJoin(orders, eq(orders.id, invoices.orderId))
      .where(listWhere(organizationId, query))
      .orderBy(
        ...orderByClause(
          {
            invoiceNumber: invoices.invoiceNumber,
            customer: invoices.customerName,
            status: invoices.status,
            dueDate: invoices.dueDate,
            total: invoices.totalMinor,
            balance: sql`${invoices.totalMinor} - ${invoices.paidMinor}`,
            issueDate: invoices.issueDate,
          },
          { sort, dir },
          [desc(invoices.invoiceNumber)],
        ),
      )
      .limit(limit)
      .offset((page - 1) * limit);
    return rows.map((r) => ({ ...r.invoice, orderNumber: r.orderNumber }));
  }

  async count({ organizationId, query }: { organizationId: string; query: InvoiceListQuery }) {
    const [total] = await db.select({ value: count() }).from(invoices).where(listWhere(organizationId, query));
    return total?.value ?? 0;
  }

  async findWithOrderNumber({ organizationId, id }: { organizationId: string; id: string }) {
    const [row] = await db
      .select({ invoice: invoices, orderNumber: orders.orderNumber })
      .from(invoices)
      .innerJoin(orders, eq(orders.id, invoices.orderId))
      .where(invoiceScope(organizationId, id));
    return row;
  }

  listOrderItems({ orderId }: { orderId: string }) {
    return db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.productName));
  }

  listPayments({ invoiceId }: { invoiceId: string }) {
    return db
      .select({ payment: payments, recordedBy: users.fullName })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.createdBy))
      .where(eq(payments.invoiceId, invoiceId))
      .orderBy(asc(payments.paidAt));
  }

  listRefundsForPayments({ paymentIds }: { paymentIds: string[] }) {
    return db.select().from(refunds).where(inArray(refunds.paymentId, paymentIds)).orderBy(asc(refunds.createdAt));
  }

  // The invoice row lock is the single choke point for money movements on that invoice.
  async lockById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [invoice] = await executor.select().from(invoices).where(invoiceScope(organizationId, id)).for('update');
    return invoice;
  }

  async findPaymentByIdempotencyKey({ organizationId, idempotencyKey }: { organizationId: string; idempotencyKey: string }, executor: DbExecutor = db) {
    const [existing] = await executor
      .select()
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.idempotencyKey, idempotencyKey)));
    return existing;
  }

  async findPaymentById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [payment] = await executor
      .select()
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.id, id)));
    return payment;
  }

  async createPayment({ values }: { values: NewPayment }, executor: DbExecutor = db) {
    const [payment] = await executor.insert(payments).values(values).returning();
    return payment!;
  }

  async createRefund({ values }: { values: NewRefund }, executor: DbExecutor = db) {
    const [refund] = await executor.insert(refunds).values(values).returning();
    return refund!;
  }

  async sumPayments({ invoiceId }: { invoiceId: string }, executor: DbExecutor = db) {
    const [paid] = await executor
      .select({ value: sumOf(payments.amountMinor) })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));
    return paid?.value ?? 0;
  }

  async sumRefundsForInvoice({ invoiceId }: { invoiceId: string }, executor: DbExecutor = db) {
    const [refunded] = await executor
      .select({ value: sumOf(refunds.amountMinor) })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(eq(payments.invoiceId, invoiceId));
    return refunded?.value ?? 0;
  }

  async sumRefundsForPayment({ paymentId }: { paymentId: string }, executor: DbExecutor = db) {
    const [refunded] = await executor
      .select({ value: sumOf(refunds.amountMinor) })
      .from(refunds)
      .where(eq(refunds.paymentId, paymentId));
    return refunded?.value ?? 0;
  }

  async updatePaid({ id, paidMinor, status }: { id: string; paidMinor: number; status: 'unpaid' | 'partial' | 'paid' }, executor: DbExecutor = db) {
    const [updated] = await executor.update(invoices).set({ paidMinor, status, updatedAt: new Date() }).where(eq(invoices.id, id)).returning();
    return updated!;
  }

  async markVoid({ id }: { id: string }, executor: DbExecutor = db) {
    const [updated] = await executor.update(invoices).set({ status: 'void', updatedAt: new Date() }).where(eq(invoices.id, id)).returning();
    return updated!;
  }
}

export const invoicesRepository = new InvoicesRepository();
