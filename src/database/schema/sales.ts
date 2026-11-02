import { bigint, boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies, contacts } from './crm.js';
import { organizations, users } from './identity.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    companyName: text('company_name'),
    source: text('source').notNull().default('other'),
    status: text('status').notNull().default('new'),
    priority: text('priority').notNull().default('medium'),
    score: integer('score').notNull().default(0),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    followUpDate: date('follow_up_date'),
    notes: text('notes'),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    convertedContactId: uuid('converted_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('leads_org_status_idx').on(t.organizationId, t.status),
    index('leads_org_created_idx').on(t.organizationId, t.createdAt),
    index('leads_org_priority_created_idx').on(t.organizationId, t.priority, t.createdAt.desc()),
    index('leads_org_source_created_idx').on(t.organizationId, t.source, t.createdAt.desc()),
    index('leads_org_deleted_idx')
      .on(t.organizationId, t.deletedAt.desc())
      .where(sql`${t.deletedAt} is not null`),
  ],
);

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('pipelines_one_default_uq')
      .on(t.organizationId)
      .where(sql`${t.isDefault}`),
  ],
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').notNull().default('open'), // open | won | lost
  },
  (t) => [uniqueIndex('stages_pipeline_position_uq').on(t.pipelineId, t.position)],
);

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    valueMinor: bigint('value_minor', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    expectedCloseDate: date('expected_close_date'),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    lostReason: text('lost_reason'),
    position: integer('position').notNull().default(0),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('deals_org_stage_idx').on(t.organizationId, t.stageId),
    index('deals_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('deals_org_pipeline_position_idx').on(t.organizationId, t.pipelineId, t.position),
    index('deals_org_deleted_idx')
      .on(t.organizationId, t.deletedAt.desc())
      .where(sql`${t.deletedAt} is not null`),
  ],
);
