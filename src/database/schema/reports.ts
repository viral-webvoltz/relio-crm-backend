import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const ownerId = () =>
  uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

// A saved report is a report type plus its query params (date range), never result data.
export const savedReports = pgTable(
  'saved_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    ownerId: ownerId(),
    name: text('name').notNull(),
    reportType: text('report_type').notNull(), // revenue-by-month | pipeline-velocity | leads-funnel
    params: jsonb('params').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('saved_reports_org_owner_idx').on(t.organizationId, t.ownerId)],
);

export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    ownerId: ownerId(),
    savedReportId: uuid('saved_report_id')
      .notNull()
      .references(() => savedReports.id, { onDelete: 'cascade' }),
    frequency: text('frequency').notNull(), // daily | weekly | monthly
    hourUtc: integer('hour_utc').notNull(),
    dayOfWeek: integer('day_of_week'), // 0 = Sunday .. 6 = Saturday (weekly only)
    dayOfMonth: integer('day_of_month'), // 1..28 so every month has the day (monthly only)
    recipients: text('recipients').array().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('report_schedules_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.isActive}`),
    index('report_schedules_org_owner_idx').on(t.organizationId, t.ownerId),
    index('report_schedules_saved_idx').on(t.savedReportId),
    check('report_schedules_hour_ck', sql`${t.hourUtc} between 0 and 23`),
    check('report_schedules_dow_ck', sql`${t.dayOfWeek} is null or ${t.dayOfWeek} between 0 and 6`),
    check('report_schedules_dom_ck', sql`${t.dayOfMonth} is null or ${t.dayOfMonth} between 1 and 28`),
    check('report_schedules_recipients_ck', sql`cardinality(${t.recipients}) between 1 and 10`),
  ],
);
