import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './identity.js';

// How long an organization keeps its own logs. Null = keep for ever (the default). Business records (orders, invoices, quotes) are never
// touched by this: they follow accounting rules, not a log policy.
export const retentionPolicies = pgTable('retention_policies', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  auditLogDays: integer('audit_log_days'),
  emailLogDays: integer('email_log_days'), // sent and failed messages in the outbox
  notificationDays: integer('notification_days'), // notifications the person has already read
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
