import { bigint, check, date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { teams } from './assignment.js';
import { organizations, users } from './identity.js';

// A target for a metric over a period. Progress is never stored: it is counted from the live data every time it is asked for.
export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    metric: text('metric').notNull(), // revenue_won | deals_won | orders_value | leads_converted | quotes_accepted | tickets_resolved
    scopeType: text('scope_type').notNull(), // organization | team | user
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    periodType: text('period_type').notNull(), // month | quarter | year | custom
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    target: bigint('target', { mode: 'number' }).notNull(), // minor units for money metrics, a plain count otherwise
    currency: text('currency'), // only money metrics
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('goals_org_period_idx').on(t.organizationId, t.endDate.desc()),
    index('goals_user_idx').on(t.userId),
    check(
      'goals_scope_target',
      sql`(${t.scopeType} = 'organization' and ${t.userId} is null and ${t.teamId} is null)
        or (${t.scopeType} = 'user' and ${t.userId} is not null and ${t.teamId} is null)
        or (${t.scopeType} = 'team' and ${t.teamId} is not null and ${t.userId} is null)`,
    ),
    check('goals_period_order', sql`${t.endDate} >= ${t.startDate}`),
  ],
);
