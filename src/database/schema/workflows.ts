import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

// "When <trigger> happens, walk the graph". The trigger is an audit/webhook event name such as deals.stage.
// `conditions` / `actions` are the legacy flat format: rows saved before the graph editor have no `graph` and are converted on read.
export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text('name').notNull(),
    trigger: text('trigger').notNull(),
    graph: jsonb('graph'),
    conditions: jsonb('conditions').notNull().default([]),
    actions: jsonb('actions'),
    isActive: boolean('is_active').notNull().default(true),
    runCount: integer('run_count').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0), // the workflow pauses itself at 10
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastScheduledOn: date('last_scheduled_on'), // UTC day a schedule/overdue trigger last fired; the claim that stops two instances firing twice
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workflows_org_trigger_idx').on(t.organizationId, t.trigger)],
);

// One row per run of a workflow (a resumed `delay` is its own run). Steps: [{ nodeId, type, status, branch?, error? }].
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id'), // the queued event that caused this run; makes a redelivered event a no-op
    event: text('event').notNull(),
    status: text('status').notNull(), // success | failed | waiting
    steps: jsonb('steps').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workflow_runs_workflow_started_idx').on(t.workflowId, t.startedAt),
    uniqueIndex('workflow_runs_event_uq')
      .on(t.workflowId, t.eventId)
      .where(sql`${t.eventId} is not null`),
  ],
);

// A path parked on a `delay` step. `context` is the event snapshot, so the run is unaffected by later changes to the record.
export const workflowJobs = pgTable(
  'workflow_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(), // the delay step; the run resumes at its successor
    context: jsonb('context').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('workflow_jobs_run_at_idx').on(t.runAt)],
);

// Durable queue between "something changed" and "workflows react". Written in the same request that made the change, drained by the worker,
// so a crash or restart between the response and the run cannot lose the event. Deleted once processed (at-least-once delivery).
export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    event: text('event').notNull(),
    actorId: uuid('actor_id').notNull(),
    workflowId: uuid('workflow_id'), // set for schedule/overdue events, which belong to one workflow rather than to everything on the trigger
    recordId: uuid('record_id'),
    values: jsonb('values').notNull(),
    changed: jsonb('changed').notNull(),
    depth: integer('depth').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workflow_events_due_idx').on(t.nextAttemptAt)],
);
