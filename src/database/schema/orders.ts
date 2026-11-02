import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { companies, contacts } from './crm.js';
import { organizations, users } from './identity.js';
import { products } from './products.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const money = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0); // integer minor units, never floats

// One counter row per organization; an atomic upsert hands out gap-free, unique order numbers.
export const orderSequences = pgTable('order_sequences', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  lastNumber: integer('last_number').notNull(),
});

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    orderNumber: integer('order_number').notNull(),
    status: text('status').notNull().default('pending'), // pending | confirmed | fulfilled | cancelled
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    customerName: text('customer_name'), // snapshot, so the order still reads correctly if the contact is deleted
    currency: text('currency').notNull(),
    subtotalMinor: money('subtotal_minor'),
    discountMinor: money('discount_minor'),
    taxMinor: money('tax_minor'),
    totalMinor: money('total_minor'),
    discountType: text('discount_type'), // percent | fixed, kept for display
    discountValue: integer('discount_value'), // basis points for percent, minor units for fixed
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_org_number_uq').on(t.organizationId, t.orderNumber),
    index('orders_org_status_idx').on(t.organizationId, t.status, t.createdAt),
    index('orders_org_contact_idx').on(t.organizationId, t.contactId, t.orderNumber.desc()), // portal: a customer's own orders
    index('orders_org_created_idx').on(t.organizationId, t.createdAt.desc()),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // Restrict: a product that was ordered cannot be deleted (deactivate it instead).
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(), // snapshots of what was sold, at the price it was sold for
    sku: text('sku'),
    unitPriceMinor: money('unit_price_minor'),
    quantity: integer('quantity').notNull(),
    lineTotalMinor: money('line_total_minor'),
    stockDeducted: boolean('stock_deducted').notNull().default(false), // only tracked products are deducted, and only those are restored
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);

export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note'),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_status_history_order_idx').on(t.orderId, t.createdAt)],
);
