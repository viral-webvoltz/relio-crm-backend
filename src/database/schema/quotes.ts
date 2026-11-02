import { bigint, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { companies, contacts } from './crm.js';
import { organizations, users } from './identity.js';
import { orders } from './orders.js';
import { products } from './products.js';
import { deals } from './sales.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const money = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0); // integer minor units, never floats

// One counter row per organization; an atomic upsert hands out gap-free, unique quote numbers.
export const quoteSequences = pgTable('quote_sequences', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  lastNumber: integer('last_number').notNull(),
});

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    quoteNumber: integer('quote_number').notNull(),
    status: text('status').notNull().default('draft'), // draft | sent | accepted | rejected  (expired is derived from validUntil)
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    customerName: text('customer_name'), // snapshot, so the quote still reads correctly if the contact is deleted
    currency: text('currency').notNull(),
    subtotalMinor: money('subtotal_minor'),
    discountMinor: money('discount_minor'),
    taxMinor: money('tax_minor'),
    totalMinor: money('total_minor'),
    discountType: text('discount_type'), // percent | fixed
    discountValue: integer('discount_value'), // basis points for percent, minor units for fixed
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    validUntil: date('valid_until'),
    notes: text('notes'), // shown to the customer
    terms: text('terms'), // shown to the customer
    // Only the hash of the customer link is stored; the link itself is returned once, when the quote is sent.
    publicTokenHash: text('public_token_hash'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    respondedByName: text('responded_by_name'), // what the customer typed when accepting
    responseNote: text('response_note'),
    convertedOrderId: uuid('converted_order_id').references(() => orders.id, { onDelete: 'set null' }),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('quotes_org_number_uq').on(t.organizationId, t.quoteNumber),
    uniqueIndex('quotes_token_uq').on(t.publicTokenHash),
    index('quotes_org_status_idx').on(t.organizationId, t.status, t.createdAt.desc()),
    index('quotes_org_contact_idx').on(t.organizationId, t.contactId),
    index('quotes_org_deal_idx').on(t.organizationId, t.dealId),
  ],
);

export const quoteItems = pgTable(
  'quote_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quotes.id, { onDelete: 'cascade' }),
    // Restrict, like order items: a quoted product is deactivated rather than deleted.
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(), // snapshots at quoting time
    sku: text('sku'),
    description: text('description'),
    unitPriceMinor: money('unit_price_minor'), // may differ from the catalogue price: it is the price being offered
    quantity: integer('quantity').notNull(),
    lineTotalMinor: money('line_total_minor'),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('quote_items_quote_idx').on(t.quoteId, t.position)],
);
