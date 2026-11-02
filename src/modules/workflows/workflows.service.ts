import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { organizations, workflowRuns, workflows } from '@/database/schema/index.js';
import { ConflictError, NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import { getOffset, type ListQuery } from '@/shared/pagination/index.js';
import { graphOf, walk } from './workflows.engine.js';
import { DEFAULT_AT, DEFAULT_DAY, isTimedTrigger } from './workflows.graph.js';
import { runAsResolver, type RunAs } from './workflows.runas.js';
import { triggers } from './workflows.meta.js';
import type { CreateWorkflowInput, SettingsInput, TestWorkflowInput, UpdateWorkflowInput } from './workflows.validation.js';

const MAX_WORKFLOWS = 50;
const scope = (organizationId: string, id: string) => and(eq(workflows.organizationId, organizationId), eq(workflows.id, id));

type Row = typeof workflows.$inferSelect;

const triggerOf = (graph: NonNullable<UpdateWorkflowInput['graph']>) => {
  const step = graph.nodes.find((n) => n.type === 'trigger');
  return step?.type === 'trigger' ? step.config.event : undefined;
};

type Schedule = { timezone: string; timezoneSource: 'workflow' | 'organization'; at: string; day: string | null };

// When a scheduled workflow actually fires: the trigger step's own settings, falling back to the organization's timezone and the defaults.
const scheduleOf = (row: Row, organizationTimezone: string): Schedule => {
  const step = graphOf(row)?.nodes.find((n) => n.type === 'trigger');
  const config = step?.type === 'trigger' ? step.config : undefined;
  return {
    timezone: config?.timezone ?? organizationTimezone,
    timezoneSource: config?.timezone ? 'workflow' : 'organization',
    at: config?.at ?? DEFAULT_AT,
    day: row.trigger === 'schedule.weekly' ? (config?.day ?? DEFAULT_DAY) : null,
  };
};

// Rows saved in the old flat format are returned as graphs too, so clients only ever see one shape.
const present = (row: Row, extra: { runsAs: RunAs; schedule: Schedule } | null) => {
  const { conditions: _c, actions: _a, createdBy: _by, organizationId: _org, lastScheduledOn: _l, ...rest } = row;
  return { ...rest, graph: graphOf(row), runsAs: extra?.runsAs ?? null, schedule: extra?.schedule ?? null };
};

const organizationTimezone = async (organizationId: string) => {
  const [org] = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return org?.timezone ?? 'UTC';
};

// Only scheduled and overdue workflows run without a person acting, so only they need `runsAs` (who runs it) and `schedule` (when).
// runsAs.problem is null when all is well; otherwise the editor should warn, and offer "Run as me" (PATCH { runAsMe: true }).
const describe = async (organizationId: string, rows: Row[]) => {
  const resolve = runAsResolver(organizationId);
  const timezone = rows.some((r) => isTimedTrigger(r.trigger)) ? await organizationTimezone(organizationId) : 'UTC';
  return Promise.all(
    rows.map(async (row) => present(row, isTimedTrigger(row.trigger) ? { runsAs: await resolve(row.createdBy), schedule: scheduleOf(row, timezone) } : null)),
  );
};

const describeOne = async (organizationId: string, row: Row) => {
  const [described] = await describe(organizationId, [row]);
  return described ?? present(row, null);
};

class WorkflowsService {
  async meta(organizationId: string) {
    return { triggers, timezone: await organizationTimezone(organizationId) };
  }

  async getSettings(organizationId: string) {
    return { timezone: await organizationTimezone(organizationId) };
  }

  // The default clock for scheduled workflows that do not name their own timezone.
  async updateSettings({ organizationId, input }: { organizationId: string; input: SettingsInput }) {
    await db
      .update(organizations)
      .set({ timezone: input.timezone, updatedAt: sql`now()` })
      .where(eq(organizations.id, organizationId));
    return { timezone: input.timezone };
  }

  // How far behind the automation is for this organization: events not yet processed (and how old the oldest is), events being
  // retried after a failure, and runs parked on a delay (and how many of those are already due).
  async queueStatus(organizationId: string) {
    const [events] = (
      await db.execute<{ pending: number; retrying: number; oldest_seconds: number }>(sql`
        select count(*)::int as pending, (count(*) filter (where attempts > 1))::int as retrying,
               coalesce(extract(epoch from now() - min(created_at)), 0)::int as oldest_seconds
        from workflow_events where organization_id = ${organizationId}`)
    ).rows;
    const [jobs] = (
      await db.execute<{ waiting: number; overdue: number }>(sql`
        select count(*)::int as waiting, (count(*) filter (where run_at <= now()))::int as overdue
        from workflow_jobs where organization_id = ${organizationId}`)
    ).rows;
    return {
      events: { pending: events?.pending ?? 0, retrying: events?.retrying ?? 0, oldestSeconds: events?.oldest_seconds ?? 0 },
      delayed: { waiting: jobs?.waiting ?? 0, overdue: jobs?.overdue ?? 0 },
    };
  }

  async list(organizationId: string) {
    const rows = await db.select().from(workflows).where(eq(workflows.organizationId, organizationId)).orderBy(desc(workflows.createdAt));
    return describe(organizationId, rows);
  }

  async create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateWorkflowInput }) {
    const [{ n = 0 } = {}] = await db.select({ n: count() }).from(workflows).where(eq(workflows.organizationId, organizationId));
    // ponytail: count-then-insert can overshoot the cap slightly under concurrent creates.
    if (n >= MAX_WORKFLOWS) throw new ConflictError(`At most ${MAX_WORKFLOWS} workflows are allowed`, 'WORKFLOW_LIMIT');
    const [row] = await db
      .insert(workflows)
      .values({ ...input, organizationId, createdBy: userId })
      .returning();
    return row && (await describeOne(organizationId, row));
  }

  async update({ organizationId, userId, id, input }: { organizationId: string; userId: string; id: string; input: UpdateWorkflowInput }) {
    const { runAsMe, ...fields } = input;
    const [row] = await db
      .update(workflows)
      .set({
        ...fields,
        // The row's trigger drives event lookup and the scheduler, so it must follow the graph's trigger step.
        ...(fields.graph && { conditions: [], actions: null, trigger: fields.trigger ?? triggerOf(fields.graph) }),
        ...(runAsMe && { createdBy: userId }),
        // Switching a workflow back on, or taking it over, is a fresh start: the failure streak that paused it must not re-pause it at once.
        ...((fields.isActive === true || runAsMe) && { consecutiveFailures: 0 }),
        updatedAt: sql`now()`,
      })
      .where(scope(organizationId, id))
      .returning();
    if (!row) throw new NotFoundError('Workflow not found');
    return await describeOne(organizationId, row);
  }

  async remove({ organizationId, id }: { organizationId: string; id: string }) {
    const deleted = await db.delete(workflows).where(scope(organizationId, id)).returning({ id: workflows.id });
    if (deleted.length === 0) throw new NotFoundError('Workflow not found');
  }

  // Dry run: which steps would run for this sample, and which way each condition goes. Nothing is written or sent.
  async test({ organizationId, userId, id, input }: { organizationId: string; userId: string; id: string; input: TestWorkflowInput }) {
    const [rule] = await db.select().from(workflows).where(scope(organizationId, id)).limit(1);
    if (!rule) throw new NotFoundError('Workflow not found');
    const graph = graphOf(rule);
    if (!graph) throw new UnprocessableEntityError('The saved workflow is not valid', 'WORKFLOW_INVALID');
    const ev = { organizationId, actorId: userId, event: rule.trigger, id: undefined, values: input.sample, changed: input.changed, depth: 0 };
    return walk({ workflowId: id, graph, ev, dryRun: true });
  }

  async listRuns({ organizationId, id, query }: { organizationId: string; id: string; query: ListQuery }) {
    const [rule] = await db.select({ id: workflows.id }).from(workflows).where(scope(organizationId, id)).limit(1);
    if (!rule) throw new NotFoundError('Workflow not found');
    const where = and(eq(workflowRuns.organizationId, organizationId), eq(workflowRuns.workflowId, id));
    const [rows, [total]] = await Promise.all([
      db.select().from(workflowRuns).where(where).orderBy(desc(workflowRuns.startedAt)).limit(query.limit).offset(getOffset(query)),
      db.select({ n: count() }).from(workflowRuns).where(where),
    ]);
    return { rows: rows.map(({ organizationId: _org, workflowId: _wf, ...run }) => run), total: total?.n ?? 0 };
  }
}

export const workflowsService = new WorkflowsService();
