import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

// The related record is polymorphic (lead | deal | contact | company), so there is no foreign key;
// the service verifies the target exists in the same organization before saving.
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    title: text('title').notNull(),
    description: text('description'),
    dueDate: date('due_date'),
    priority: text('priority').notNull().default('medium'),
    status: text('status').notNull().default('open'),
    recurrence: text('recurrence').notNull().default('none'), // none | daily | weekly | monthly
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('tasks_org_status_due_idx').on(t.organizationId, t.status, t.dueDate),
    index('tasks_org_related_idx').on(t.organizationId, t.relatedType, t.relatedId),
    index('tasks_assignee_idx').on(t.assignedTo),
    index('tasks_org_assignee_status_idx').on(t.organizationId, t.assignedTo, t.status),
    index('tasks_org_due_idx').on(t.organizationId, t.dueDate),
    index('tasks_org_deleted_idx')
      .on(t.organizationId, t.deletedAt.desc())
      .where(sql`${t.deletedAt} is not null`),
  ],
);

export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    type: text('type').notNull(), // note | call | meeting | email
    subject: text('subject').notNull(),
    body: text('body'),
    relatedType: text('related_type').notNull(),
    relatedId: uuid('related_id').notNull(),
    // Set only on type 'email': sent from the CRM or received as a reply. messageId has no angle brackets, so it matches In-Reply-To / References.
    direction: text('direction'), // outbound | inbound
    emailAddress: text('email_address'),
    messageId: text('message_id'),
    threadId: text('thread_id'), // the Gmail conversation an outbound email was sent in, so a reply in that thread finds its way back
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('activities_org_message_id_uq')
      .on(t.organizationId, t.messageId)
      .where(sql`${t.messageId} is not null`),
    index('activities_org_thread_idx')
      .on(t.organizationId, t.threadId)
      .where(sql`${t.threadId} is not null`),
    index('activities_related_idx').on(t.organizationId, t.relatedType, t.relatedId, t.occurredAt),
    index('activities_org_occurred_idx').on(t.organizationId, t.occurredAt.desc()),
  ],
);
