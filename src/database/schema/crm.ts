import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    website: text('website'),
    industry: text('industry'),
    phone: text('phone'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('companies_org_name_idx').on(t.organizationId, t.name),
    index('companies_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('companies_org_deleted_idx')
      .on(t.organizationId, t.deletedAt.desc())
      .where(sql`${t.deletedAt} is not null`),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    jobTitle: text('job_title'),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('contacts_org_name_idx').on(t.organizationId, t.firstName),
    index('contacts_company_idx').on(t.companyId),
    index('contacts_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    uniqueIndex('contacts_org_email_uq')
      .on(t.organizationId, t.email)
      .where(sql`${t.email} is not null and ${t.deletedAt} is null`),
    index('contacts_org_deleted_idx')
      .on(t.organizationId, t.deletedAt.desc())
      .where(sql`${t.deletedAt} is not null`),
  ],
);
