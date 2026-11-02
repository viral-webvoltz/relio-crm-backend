import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('product_categories_org_name_uq').on(t.organizationId, t.name)],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    categoryId: uuid('category_id').references(() => productCategories.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    sku: text('sku'),
    description: text('description'),
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull().default(0), // money is integer minor units, never floats
    currency: text('currency').notNull().default('USD'),
    trackInventory: boolean('track_inventory').notNull().default(true),
    stockQuantity: integer('stock_quantity').notNull().default(0),
    reorderLevel: integer('reorder_level').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('products_org_name_idx').on(t.organizationId, t.name),
    index('products_category_idx').on(t.categoryId),
    index('products_org_active_name_idx').on(t.organizationId, t.isActive, t.name),
    index('products_org_category_name_idx').on(t.organizationId, t.categoryId, t.name),
    uniqueIndex('products_org_sku_uq')
      .on(t.organizationId, t.sku)
      .where(sql`${t.sku} is not null and ${t.deletedAt} is null`),
    index('products_org_deleted_idx')
      .on(t.organizationId, t.deletedAt.desc())
      .where(sql`${t.deletedAt} is not null`),
  ],
);

// Append-only history of every stock change, so a quantity can always be explained.
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stock_movements_product_idx').on(t.productId, t.createdAt)],
);
