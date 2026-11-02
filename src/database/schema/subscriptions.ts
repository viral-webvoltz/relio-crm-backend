import { bigint, boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies, contacts } from './crm.js';
import { organizations, users } from './identity.js';
import { invoices } from './invoices.js';
import { orders } from './orders.js';
import { products } from './products.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

// A standing order: on every billing date the scheduler places an order and invoices it, at the prices agreed here.
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'), // active | paused | cancelled | completed
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    customerName: text('customer_name'),
    currency: text('currency').notNull(),
    discountType: text('discount_type'), // percent | fixed
    discountValue: integer('discount_value'), // basis points for percent, minor units for fixed
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    intervalUnit: text('interval_unit').notNull(), // week | month | year
    intervalCount: integer('interval_count').notNull().default(1),
    startOn: date('start_on').notNull(),
    endOn: date('end_on'),
    maxRuns: integer('max_runs'),
    cycle: integer('cycle').notNull().default(0), // billing dates passed so far, billed or skipped (while paused)
    runCount: integer('run_count').notNull().default(0), // invoices generated so far
    nextRunOn: date('next_run_on'), // null once finished
    dueDays: integer('due_days').notNull().default(14), // payment terms of each invoice
    autoSend: boolean('auto_send').notNull().default(false), // email each invoice to the contact
    notes: text('notes'),
    failureCount: integer('failure_count').notNull().default(0), // consecutive failed attempts; three pause the subscription
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_org_status_idx').on(t.organizationId, t.status, t.nextRunOn),
    index('subscriptions_due_idx')
      .on(t.nextRunOn)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const subscriptionItems = pgTable(
  'subscription_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(), // fixed for the life of the subscription unless edited
  },
  (t) => [index('subscription_items_sub_idx').on(t.subscriptionId)],
);

// One row per billing attempt. A unique index over the billing date of successful runs is what makes double billing impossible.
export const subscriptionRuns = pgTable(
  'subscription_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    scheduledFor: date('scheduled_for').notNull(),
    status: text('status').notNull(), // invoiced | failed
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_runs_billed_uq')
      .on(t.subscriptionId, t.scheduledFor)
      .where(sql`${t.status} = 'invoiced'`),
    index('subscription_runs_sub_idx').on(t.subscriptionId, t.createdAt.desc()),
  ],
);
