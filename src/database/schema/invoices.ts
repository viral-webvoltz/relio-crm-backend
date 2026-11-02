import { bigint, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';
import { orders } from './orders.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const money = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0); // integer minor units, never floats

// One counter row per organization; an atomic upsert hands out gap-free, unique invoice numbers.
export const invoiceSequences = pgTable('invoice_sequences', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  lastNumber: integer('last_number').notNull(),
});

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    invoiceNumber: integer('invoice_number').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('unpaid'), // unpaid | partial | paid | void
    customerName: text('customer_name'), // snapshot of the order's customer
    currency: text('currency').notNull(),
    totalMinor: money('total_minor'), // snapshot of the order total when invoiced
    paidMinor: money('paid_minor'), // payments minus refunds, recomputed after every money movement
    issueDate: date('issue_date')
      .notNull()
      .default(sql`current_date`),
    dueDate: date('due_date').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoices_org_number_uq').on(t.organizationId, t.invoiceNumber),
    // At most one live invoice per order; a voided one can be replaced.
    uniqueIndex('invoices_one_live_per_order_uq')
      .on(t.orderId)
      .where(sql`${t.status} <> 'void'`),
    index('invoices_org_status_due_idx').on(t.organizationId, t.status, t.dueDate),
    index('invoices_org_due_idx').on(t.organizationId, t.dueDate),
    index('invoices_org_issue_idx').on(t.organizationId, t.issueDate),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    method: text('method').notNull(), // cash | card | bank_transfer | upi | other
    reference: text('reference'),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    // Sent by the client once per form submission, so a double click or retry cannot record the payment twice.
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_invoice_idx').on(t.invoiceId),
    uniqueIndex('payments_org_idempotency_uq')
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refunds_payment_idx').on(t.paymentId)],
);
