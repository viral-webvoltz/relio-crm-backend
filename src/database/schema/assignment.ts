import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('teams_org_name_uq').on(t.organizationId, sql`lower(${t.name})`)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: orgId(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index('team_members_user_idx').on(t.userId)],
);

export type AssignmentTarget = { type: 'user'; userId: string } | { type: 'team'; teamId: string; strategy: 'round_robin' | 'least_loaded' };
export type AssignmentConditions = { mode: 'all' | 'any'; rules: { field: string; operator: string; value?: string | undefined }[] };

// The first active rule (lowest position) whose conditions match a new record decides who gets it.
export const assignmentRules = pgTable(
  'assignment_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    resource: text('resource').notNull(), // leads | tickets
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    conditions: jsonb('conditions').$type<AssignmentConditions>().notNull(), // no rules = matches everything
    target: jsonb('target').$type<AssignmentTarget>().notNull(),
    lastUserId: uuid('last_user_id'), // the round-robin cursor: who got the previous record from this rule
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assignment_rules_org_resource_idx').on(t.organizationId, t.resource, t.position)],
);
