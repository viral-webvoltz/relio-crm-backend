import { integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './identity.js';

// One policy per organization; without a row the defaults in code apply (see modules/support/sla.policy.ts).
export const slaPolicies = pgTable('sla_policies', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // { urgent|high|medium|low: { firstResponseMinutes, resolutionMinutes } }
  targets: jsonb('targets').$type<Record<'urgent' | 'high' | 'medium' | 'low', { firstResponseMinutes: number; resolutionMinutes: number }>>().notNull(),
  // null = the clock runs around the clock
  businessHours: jsonb('business_hours').$type<{ timezone: string; days: number[]; start: string; end: string } | null>(),
  warnAtPercent: integer('warn_at_percent').notNull().default(80),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
