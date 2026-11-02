import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { invoices, organizations, tasks, workflowEvents, workflows } from '@/database/schema/index.js';
import { logger } from '@/shared/utils/logger.js';
import { sanitizeValues } from './workflows.events.js';
import { graphOf, recordSkippedRun } from './workflows.engine.js';
import { notifyWorkflowOwners, runAsResolver } from './workflows.runas.js';
import { DEFAULT_AT, DEFAULT_DAY, isTimedTrigger } from './workflows.graph.js';

const OVERDUE_WINDOW_DAYS = 7; // only records that became overdue recently fire, so turning a workflow on does not replay old history
const MAX_RECORDS_PER_SCAN = 500;

type Rule = typeof workflows.$inferSelect;

// A stable id from a seed (same input, same uuid), so re-enqueueing the same thing is a no-op: the queue row and the run both dedupe on it.
const uuidFrom = (seed: string) => {
  const h = createHash('sha1').update(seed).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
};

const daysAgo = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

// Which records a trigger fires for. Schedules fire once with no record; the overdue triggers fire once per record, ever, per workflow.
async function recordsFor(rule: Rule, today: string): Promise<{ id: string | null; values: Record<string, unknown> }[]> {
  const since = daysAgo(today, OVERDUE_WINDOW_DAYS);
  if (rule.trigger === 'tasks.overdue') {
    const rows = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, rule.organizationId),
          eq(tasks.status, 'open'),
          isNull(tasks.deletedAt),
          lt(tasks.dueDate, today),
          gte(tasks.dueDate, since),
        ),
      )
      .limit(MAX_RECORDS_PER_SCAN);
    return rows.map((r) => ({ id: r.id, values: r }));
  }
  if (rule.trigger === 'invoices.overdue') {
    const rows = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, rule.organizationId),
          inArray(invoices.status, ['unpaid', 'partial']),
          lt(invoices.dueDate, today),
          gte(invoices.dueDate, since),
        ),
      )
      .limit(MAX_RECORDS_PER_SCAN);
    return rows.map((r) => ({ id: r.id, values: r }));
  }
  return [{ id: null, values: { date: today } }]; // schedule.daily / schedule.weekly
}

async function fire(rule: Rule, today: string) {
  // The creator, or when they are gone or deactivated an active admin; with neither, say so on the run instead of skipping silently.
  const runAs = await runAsResolver(rule.organizationId)(rule.createdBy);
  if (!runAs.willRunAs) {
    logger.warn({ workflowId: rule.id, problem: runAs.problem }, 'Scheduled workflow has nobody to run as');
    await notifyWorkflowOwners({
      organizationId: rule.organizationId,
      createdBy: rule.createdBy,
      title: `Workflow "${rule.name}" could not run`,
      body: 'Its creator is gone and no active admin was found, so nobody can run it. Open the workflow and choose "Run as me".',
      dedupeKey: `workflow_orphan:${rule.id}:${today}`,
    });
    await recordSkippedRun(
      rule,
      'Nobody is available to run this workflow as: its creator is gone and no active admin was found. Open the workflow and choose "Run as me".',
    );
    return;
  }
  const actor = runAs.willRunAs;
  if (runAs.problem) logger.info({ workflowId: rule.id, runAs: actor.id, problem: runAs.problem }, 'Scheduled workflow runs as a fallback admin');
  const isSchedule = rule.trigger.startsWith('schedule.');
  const records = await recordsFor(rule, today);
  if (records.length === 0) return;
  await db
    .insert(workflowEvents)
    .values(
      records.map((r) => ({
        id: uuidFrom(isSchedule ? `${rule.id}:${today}` : `${rule.id}:${r.id}`),
        organizationId: rule.organizationId,
        workflowId: rule.id,
        event: rule.trigger,
        actorId: actor.id,
        recordId: r.id,
        values: sanitizeValues(r.values),
        changed: [],
      })),
    )
    .onConflictDoNothing();
}

// The date, time and weekday on the wall clock of `timeZone` at this instant.
export function localParts(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday?.toLowerCase().slice(0, 3) ?? '' };
}

// Called every minute by the worker. Each timed workflow fires at most once per day on ITS OWN clock: its `timezone` (default: the organization's, which itself defaults to UTC) and
// `at` time (default 09:00); schedule.weekly also needs the `day` (default Monday) to match.
// The claim is one conditional UPDATE, so several instances running this at once still fire a workflow only once.
export async function fireDueSchedules(now = new Date()): Promise<number> {
  const rules = await db
    .select({ rule: workflows, orgTimezone: organizations.timezone })
    .from(workflows)
    .innerJoin(organizations, eq(organizations.id, workflows.organizationId))
    .where(and(eq(workflows.isActive, true), or(like(workflows.trigger, 'schedule.%'), like(workflows.trigger, '%.overdue'))));

  let fired = 0;
  for (const { rule, orgTimezone } of rules) {
    if (!isTimedTrigger(rule.trigger)) continue;
    const trigger = graphOf(rule)?.nodes.find((n) => n.type === 'trigger');
    const config = trigger?.type === 'trigger' ? trigger.config : undefined;
    const local = localParts(now, config?.timezone ?? orgTimezone);
    if (rule.lastScheduledOn === local.date || local.time < (config?.at ?? DEFAULT_AT)) continue;
    if (rule.trigger === 'schedule.weekly' && local.weekday !== (config?.day ?? DEFAULT_DAY)) continue;

    const claimed = await db
      .update(workflows)
      .set({ lastScheduledOn: local.date })
      .where(and(eq(workflows.id, rule.id), or(isNull(workflows.lastScheduledOn), lt(workflows.lastScheduledOn, local.date))))
      .returning({ id: workflows.id });
    if (claimed.length === 0) continue; // another instance got it
    try {
      await fire(rule, local.date);
      fired++;
    } catch (err) {
      logger.error({ err, workflowId: rule.id }, 'Failed to fire a scheduled workflow');
      await db
        .update(workflows)
        .set({ lastScheduledOn: sql`null` })
        .where(eq(workflows.id, rule.id)); // try again on the next pass
    }
  }
  return fired;
}
