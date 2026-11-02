import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './identity.js';

export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(), // lead | contact | deal
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(), // text | number | date | boolean | select
    options: jsonb('options').$type<string[]>(), // select only
    required: boolean('required').notNull().default(false),
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('custom_field_defs_org_entity_key_uq').on(t.organizationId, t.entityType, t.key),
    check('custom_field_defs_entity_type_chk', sql`${t.entityType} in ('lead', 'contact', 'deal')`),
    check('custom_field_defs_type_chk', sql`${t.type} in ('text', 'number', 'date', 'boolean', 'select')`),
    check('custom_field_defs_key_chk', sql`${t.key} ~ '^[a-z][a-z0-9_]{0,39}$'`),
  ],
);
