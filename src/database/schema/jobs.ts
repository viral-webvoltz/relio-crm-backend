import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './identity.js';

// Background jobs (CSV export / import). Always read scoped to organization AND the creating user.
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // export | import
    status: text('status').notNull().default('queued'), // queued | running | done | failed
    progress: integer('progress').notNull().default(0), // 0-100
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result'),
    error: text('error'),
    fileName: text('file_name'),
    fileContent: text('file_content'), // the produced CSV (export) or the failed-rows CSV (import), capped by the handlers
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('jobs_org_user_created_idx').on(t.organizationId, t.userId, t.createdAt), index('jobs_status_created_idx').on(t.status, t.createdAt)],
);
