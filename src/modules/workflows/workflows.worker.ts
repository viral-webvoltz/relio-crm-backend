import { eq, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { workflowEvents, workflowJobs, workflowRuns } from '@/database/schema/index.js';
import { logger } from '@/shared/utils/logger.js';
import { processEvent, resumeWorkflow } from './workflows.engine.js';
import { fireDueSchedules } from './workflows.schedule.js';

const POLL_MS = 3_000;
const BATCH = 20;
const LEASE_SECONDS = 300; // work whose process died mid-run becomes due again after this (so a step can, rarely, run twice)
const MAX_EVENT_ATTEMPTS = 5;
const backoffSeconds = (attempts: number) => 2 ** attempts * 15;
const RUN_RETENTION_DAYS = 30;
const PURGE_MS = 60 * 60_000;

// Takes the next due row and pushes its due time out by the lease, so parallel instances never pick the same one.
function claimEvent() {
  return db.execute<{
    id: string;
    organization_id: string;
    event: string;
    actor_id: string;
    workflow_id: string | null;
    record_id: string | null;
    values: Record<string, unknown>;
    changed: string[];
    depth: number;
    attempts: number;
  }>(sql`
    update workflow_events set attempts = attempts + 1, next_attempt_at = now() + ${LEASE_SECONDS} * interval '1 second'
    where id = (select id from workflow_events where next_attempt_at <= now() order by next_attempt_at limit 1 for update skip locked)
    returning id, organization_id, event, actor_id, workflow_id, record_id, values, changed, depth, attempts`);
}

function claimJob() {
  return db.execute<{ id: string; workflow_id: string; organization_id: string; node_id: string; context: unknown }>(sql`
    update workflow_jobs set run_at = now() + ${LEASE_SECONDS} * interval '1 second'
    where id = (select id from workflow_jobs where run_at <= now() order by run_at limit 1 for update skip locked)
    returning id, workflow_id, organization_id, node_id, context`);
}

const BACKLOG_WARN_SECONDS = 300;

// Events that are due but unclaimed for minutes mean the worker is stuck or overloaded. Logged, so an alert on the message can page someone.
async function warnOnBacklog() {
  const [row] = (
    await db.execute<{ due: number; oldest_seconds: number }>(sql`
      select count(*)::int as due, coalesce(extract(epoch from now() - min(created_at)), 0)::int as oldest_seconds
      from workflow_events where next_attempt_at <= now()`)
  ).rows;
  if (row && row.due > 0 && row.oldest_seconds > BACKLOG_WARN_SECONDS)
    logger.warn({ due: row.due, oldestSeconds: row.oldest_seconds }, 'Workflow event backlog');
}

async function drainEvents() {
  for (let i = 0; i < BATCH; i++) {
    const [row] = (await claimEvent()).rows;
    if (!row) return;
    try {
      await processEvent({
        eventId: row.id,
        organizationId: row.organization_id,
        actorId: row.actor_id,
        ...(row.workflow_id && { workflowId: row.workflow_id }),
        event: row.event,
        id: row.record_id ?? undefined,
        values: row.values,
        changed: row.changed,
        depth: row.depth,
      });
      await db.delete(workflowEvents).where(eq(workflowEvents.id, row.id));
    } catch (err) {
      // Infrastructure trouble (the database, mostly). Retry with backoff; give up after a few attempts so one bad event cannot loop forever.
      const giveUp = row.attempts >= MAX_EVENT_ATTEMPTS;
      logger.error({ err, eventId: row.id, attempts: row.attempts }, giveUp ? 'Workflow event failed permanently' : 'Workflow event failed, will retry');
      await (giveUp
        ? db.delete(workflowEvents).where(eq(workflowEvents.id, row.id))
        : db
            .update(workflowEvents)
            .set({ nextAttemptAt: sql`now() + ${backoffSeconds(row.attempts)} * interval '1 second'` })
            .where(eq(workflowEvents.id, row.id)));
    }
  }
}

async function drainJobs() {
  for (let i = 0; i < BATCH; i++) {
    const [job] = (await claimJob()).rows;
    if (!job) return;
    try {
      await resumeWorkflow({ workflowId: job.workflow_id, organizationId: job.organization_id, nodeId: job.node_id, context: job.context });
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'Resuming a workflow failed');
    }
    await db.delete(workflowJobs).where(eq(workflowJobs.id, job.id)); // done, or failed and logged: never retried automatically
  }
}

let lastPurge = 0;
let lastScheduleCheck = 0;
const SCHEDULE_CHECK_MS = 60_000;

// One pass over everything that is due. Exported so tests (and an operator, if ever needed) can drive the queue deterministically.
export async function runWorkflowTick() {
  if (Date.now() - lastPurge > PURGE_MS) {
    lastPurge = Date.now();
    await db.delete(workflowRuns).where(sql`${workflowRuns.startedAt} < now() - ${RUN_RETENTION_DAYS} * interval '1 day'`);
  }
  if (Date.now() - lastScheduleCheck > SCHEDULE_CHECK_MS) {
    lastScheduleCheck = Date.now();
    await fireDueSchedules();
    await warnOnBacklog();
  }
  await drainEvents();
  await drainJobs();
}

// Returns a stop function that also waits for the pass in flight, so shutdown does not cut a run in half.
export function startWorkflowWorker(): () => Promise<void> {
  let current: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (current) return;
    current = runWorkflowTick()
      .catch((err: unknown) => logger.error({ err }, 'Workflow worker tick failed'))
      .finally(() => {
        current = null;
      });
  }, POLL_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await current;
  };
}
