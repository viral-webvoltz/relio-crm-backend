import { recordEmailsService } from '@/modules/record-emails/record-emails.service.js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/config/database.js';
import { tasks, users, workflowJobs, workflowRuns, workflows } from '@/database/schema/index.js';
import { postgresCounterStore } from '@/middleware/rate-limit.store.js';
import { relatedTypes } from '@/modules/activities/activities.related.js';
import { queueEmail } from '@/modules/mail/mail.service.js';
import { esc } from '@/modules/mail/mail.templates.js';
import { notificationsRepository } from '@/modules/notifications/notifications.repository.js';
import { isBlockedError, sendRequest } from '@/modules/webhooks/webhooks.http.js';
import { urlProblem } from '@/modules/webhooks/webhooks.ssrf.js';
import { logger } from '@/shared/utils/logger.js';
import { notifyWorkflowOwners } from './workflows.runas.js';
import { evaluateGroup, render, type Values } from './workflows.conditions.js';
import { flatToGraph, delayMinutes, graphSchema, triggerResource, type Graph, type GraphNode, type NodeOf } from './workflows.graph.js';
import { enqueueWorkflowEvent } from './workflows.events.js';
import { editable, fieldProblem, isEditableResource, isUserField } from './workflows.records.js';

export type WorkflowEvent = {
  organizationId: string;
  actorId: string;
  event: string; // e.g. deals.stage
  id: string | undefined; // the record the request touched
  values: Values; // submitted fields over the stored record, so conditions see the real state
  changed: string[]; // top-level fields the request submitted
  depth: number; // how many workflow-caused updates deep this event is
  eventId?: string; // the queued event being processed; a run is recorded once per (workflow, eventId)
  workflowId?: string; // set for schedule/overdue events, which run one workflow only
};

export type StepResult = {
  nodeId: string;
  type: GraphNode['type'];
  status: 'ok' | 'failed' | 'waiting' | 'would_run';
  branch?: 'true' | 'false';
  error?: string;
  ms?: number;
};
export type RunResult = { status: 'success' | 'failed' | 'waiting'; steps: StepResult[] };

const CHAIN_EVENTS_PER_MINUTE = 200; // workflow-caused update events per organization, so rules triggering rules cannot flood the queue
const MAX_DEPTH = 5; // update_record -> workflow -> update_record chains stop here
const MAX_STEPS_PER_RUN = 100;
const STEP_LIMIT_PER_HOUR = 100; // emails and HTTP calls, per workflow
const HTTP_TIMEOUT_MS = 10_000;
const HTTP_ATTEMPTS = 3; // network errors, 429 and 5xx are retried; anything else is final
const MAX_CONSECUTIVE_FAILURES = 10; // then the workflow pauses itself and tells its creator
const ctx = (ev: WorkflowEvent) => ({ event: ev.event, id: ev.id, values: ev.values });

// Emails and outbound calls are the steps that reach outside; cap each workflow per hour, counted in the shared database store.
async function withinHourlyLimit(workflowId: string, kind: 'email' | 'http') {
  try {
    const [hit] = await postgresCounterStore.hit([`wf:${workflowId}:${kind}`], 3600);
    return !hit || hit.count <= STEP_LIMIT_PER_HOUR;
  } catch (err) {
    logger.warn({ err }, 'Workflow rate limit store unavailable; allowing the step'); // fail open, like the API limiter
    return true;
  }
}

async function withinChainLimit(organizationId: string) {
  try {
    const [hit] = await postgresCounterStore.hit([`wf:${organizationId}:chain`], 60);
    return !hit || hit.count <= CHAIN_EVENTS_PER_MINUTE;
  } catch (err) {
    logger.warn({ err }, 'Workflow chain limit store unavailable; allowing the event');
    return true;
  }
}

const who = (target: string, actorId: string) => (target === 'actor' ? actorId : target);

async function assertOrgUser(organizationId: string, userId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new Error('The chosen user does not exist in this organization');
}

async function updateRecord(node: NodeOf<'update_record'>, ev: WorkflowEvent) {
  const resource = triggerResource(ev.event);
  const { field } = node.config;
  const value = render(node.config.value, ctx(ev));
  const problem = fieldProblem(resource, field, value, { rendered: true });
  if (problem || !isEditableResource(resource)) throw new Error(problem ?? 'Update record is not available here');
  if (!ev.id) throw new Error('This event has no record to update');
  if (isUserField(field) && value !== '') await assertOrgUser(ev.organizationId, value);

  // One table per resource; every one has organization_id, id and updated_at. The cast only quiets the union of table types.
  const table = editable[resource].table as unknown as typeof tasks;
  await db
    .update(table)
    .set({ [field]: value === '' ? null : value, updatedAt: sql`now()` } as never)
    .where(and(eq(table.id, ev.id), eq(table.organizationId, ev.organizationId)));

  // The change counts as an update other workflows may react to. The depth counter breaks any ping-pong between rules.
  if (ev.depth + 1 < MAX_DEPTH && (await withinChainLimit(ev.organizationId))) {
    await enqueueWorkflowEvent({
      organizationId: ev.organizationId,
      actorId: ev.actorId,
      event: `${resource}.update`,
      id: ev.id,
      values: { ...ev.values, [field]: value },
      changed: [field],
      depth: ev.depth + 1,
    });
  }
}

async function httpRequest(node: NodeOf<'http_request'>, ev: WorkflowEvent, workflowId: string) {
  if (!(await withinHourlyLimit(workflowId, 'http'))) throw new Error('Hourly limit for HTTP requests reached');
  const { method } = node.config;
  const url = render(node.config.url, ctx(ev), encodeURIComponent);
  const problem = urlProblem(url);
  if (problem) throw new Error(problem);
  const body = method === 'GET' || !node.config.body ? undefined : render(node.config.body, ctx(ev), (s) => JSON.stringify(s).slice(1, -1));

  let lastError = 'The request failed';
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++) {
    try {
      const status = await sendRequest({ url, method, body, timeoutMs: HTTP_TIMEOUT_MS });
      if (status < 400) return;
      lastError = `The server answered HTTP ${status}`;
      if (status !== 429 && status < 500) break; // a client error will not fix itself
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
      if (isBlockedError(err)) break; // never retry a blocked destination
    }
    if (attempt < HTTP_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw new Error(lastError);
}

async function sendEmail(node: NodeOf<'send_email'>, ev: WorkflowEvent, workflowId: string) {
  if (!(await withinHourlyLimit(workflowId, 'email'))) throw new Error('Hourly limit for emails reached');
  const to = render(node.config.to, ctx(ev)).trim();
  if (!z.email().max(254).safeParse(to).success) throw new Error('The recipient is not a valid email address');
  const text = render(node.config.body, ctx(ev));

  // An email to the lead or contact that triggered the workflow goes out as a normal email from that record: it is logged in their history,
  // carries a reply address, and their answer comes back into the CRM (moving the lead's status). Any other recipient is a plain email.
  const resource = triggerResource(ev.event);
  const recordType = resource === 'leads' ? 'lead' : resource === 'contacts' ? 'contact' : undefined;
  if (recordType && ev.id && to.toLowerCase() === String(ev.values.email ?? '').trim().toLowerCase()) {
    await recordEmailsService.send({
      organizationId: ev.organizationId,
      userId: ev.actorId,
      type: recordType,
      id: ev.id,
      input: { subject: render(node.config.subject, ctx(ev)).slice(0, 200), body: text.slice(0, 10_000) },
    });
    return;
  }

  const html = `<p>${render(esc(node.config.body), ctx(ev), esc).replace(/\r?\n/g, '<br>')}</p>`;
  const queued = await queueEmail({
    organizationId: ev.organizationId,
    kind: 'workflow',
    to,
    subject: render(node.config.subject, ctx(ev)),
    html,
    text,
    ...(ev.id && { relatedType: triggerResource(ev.event) ?? '', relatedId: ev.id }),
  });
  if (!queued) throw new Error('Email is not configured');
}

async function createTask(node: NodeOf<'create_task'>, ev: WorkflowEvent) {
  const { config } = node;
  const assignee = who(config.assignTo, ev.actorId);
  await assertOrgUser(ev.organizationId, assignee);
  const entity = triggerResource(ev.event)?.replace(/s$/, '');
  const related = relatedTypes.find((t) => t === entity) && ev.id ? { relatedType: entity, relatedId: ev.id } : {};
  const due = config.dueInDays === undefined ? undefined : new Date(Date.now() + config.dueInDays * 86_400_000).toISOString().slice(0, 10);
  await db.insert(tasks).values({
    organizationId: ev.organizationId,
    title: render(config.title, ctx(ev)),
    ...(config.description && { description: render(config.description, ctx(ev)) }),
    priority: config.priority,
    ...(due && { dueDate: due }),
    assignedTo: assignee,
    createdBy: ev.actorId,
    ...related,
  });
}

async function notifyUser(node: NodeOf<'notify'>, ev: WorkflowEvent) {
  const userId = who(node.config.userId, ev.actorId);
  await assertOrgUser(ev.organizationId, userId);
  // Inserted directly: notify() skips the actor, but an explicit "notify me" step should still reach them.
  await notificationsRepository.insert({
    organizationId: ev.organizationId,
    userId,
    type: 'workflow',
    title: render(node.config.title, ctx(ev)),
    ...(node.config.body && { body: render(node.config.body, ctx(ev)) }),
  });
}

type WalkInput = { workflowId: string; graph: Graph; ev: WorkflowEvent; dryRun?: boolean; resumeAfter?: string };

// A path through the graph is linear: every step has one output, and a condition picks one of its two. Run steps until the path ends,
// a step fails, or a delay parks the rest of the path in workflow_jobs.
export async function walk({ workflowId, graph, ev, dryRun = false, resumeAfter }: WalkInput): Promise<RunResult> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = new Map(graph.edges.map((e) => [`${e.source}:${e.sourceHandle}`, e.target]));
  const steps: StepResult[] = [];

  const startId = resumeAfter ?? graph.nodes.find((n) => n.type === 'trigger')?.id;
  let current = startId === undefined ? undefined : next.get(`${startId}:next`);

  for (let i = 0; current !== undefined && i < MAX_STEPS_PER_RUN; i++) {
    const node = byId.get(current);
    if (!node) break;
    const step: StepResult = { nodeId: node.id, type: node.type, status: dryRun ? 'would_run' : 'ok' };
    const startedAt = Date.now();
    steps.push(step);
    try {
      if (node.type === 'condition') {
        const passed = evaluateGroup(node.config.mode, node.config.rules, ev.values, ev.changed);
        step.branch = passed ? 'true' : 'false';
        step.ms = Date.now() - startedAt;
        current = next.get(`${node.id}:${step.branch}`);
        continue;
      }
      if (node.type === 'delay') {
        if (!dryRun) {
          const runAt = new Date(Date.now() + delayMinutes(node.config) * 60_000);
          await db.insert(workflowJobs).values({ organizationId: ev.organizationId, workflowId, nodeId: node.id, context: ev, runAt });
          step.status = 'waiting';
          step.ms = Date.now() - startedAt;
          return { status: 'waiting', steps };
        }
      } else if (!dryRun) {
        if (node.type === 'create_task') await createTask(node, ev);
        else if (node.type === 'notify') await notifyUser(node, ev);
        else if (node.type === 'update_record') await updateRecord(node, ev);
        else if (node.type === 'send_email') await sendEmail(node, ev, workflowId);
        else if (node.type === 'http_request') await httpRequest(node, ev, workflowId);
      }
    } catch (err) {
      step.status = 'failed';
      step.error = err instanceof Error ? err.message.slice(0, 500) : 'Step failed';
      step.ms = Date.now() - startedAt;
      logger.error({ err, workflowId, nodeId: node.id }, 'Workflow step failed');
      return { status: 'failed', steps };
    }
    step.ms = Date.now() - startedAt;
    current = next.get(`${node.id}:next`);
  }
  return { status: 'success', steps };
}

type Rule = typeof workflows.$inferSelect;

// Rows saved before the graph editor have no graph: build it from the flat fields. Returns null when the stored graph is unusable.
export function graphOf(rule: Pick<Rule, 'graph' | 'trigger' | 'conditions' | 'actions'>): Graph | null {
  if (rule.graph) {
    const parsed = graphSchema.safeParse(rule.graph);
    return parsed.success ? parsed.data : null;
  }
  const flat = flatToGraph(rule.trigger, rule.conditions as never, (rule.actions ?? []) as never);
  const parsed = graphSchema.safeParse(flat);
  return parsed.success ? parsed.data : null;
}

const firstError = (steps: StepResult[]) => steps.find((s) => s.status === 'failed')?.error ?? null;

// Writes the run, updates the workflow's counters, and pauses a workflow that keeps failing (so a broken rule cannot hammer
// an endpoint or fill the logs forever). A run counts as failed only when a step failed; a path parked on a delay is not a failure.
async function recordRun(
  rule: Pick<Rule, 'id' | 'organizationId' | 'name' | 'createdBy'>,
  ev: Pick<WorkflowEvent, 'event'>,
  result: RunResult,
  { count, eventId }: { count: boolean; eventId: string | null },
) {
  await db
    .insert(workflowRuns)
    .values({ organizationId: rule.organizationId, workflowId: rule.id, eventId, event: ev.event, status: result.status, steps: result.steps })
    .onConflictDoNothing();
  const failed = result.status === 'failed';
  const [after] = await db
    .update(workflows)
    .set({
      ...(count && { runCount: sql`${workflows.runCount} + 1` }),
      lastRunAt: sql`now()`,
      lastError: firstError(result.steps),
      consecutiveFailures: failed ? sql`${workflows.consecutiveFailures} + 1` : 0,
      ...(failed && { isActive: sql`${workflows.consecutiveFailures} + 1 < ${MAX_CONSECUTIVE_FAILURES}` }),
    })
    .where(eq(workflows.id, rule.id))
    .returning({ isActive: workflows.isActive });
  if (failed && after && !after.isActive) {
    logger.warn({ workflowId: rule.id }, 'Workflow paused after repeated failures');
    await notifyWorkflowOwners({
      organizationId: rule.organizationId,
      createdBy: rule.createdBy,
      title: `Workflow "${rule.name}" was paused`,
      body: `It failed ${MAX_CONSECUTIVE_FAILURES} times in a row. Last error: ${firstError(result.steps) ?? 'unknown'}`,
      dedupeKey: `workflow_paused:${rule.id}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
}

const invalidRun: RunResult = { status: 'failed', steps: [{ nodeId: '', type: 'trigger', status: 'failed', error: 'The saved workflow is not valid' }] };

// Runs every active workflow on this event. Step failures are recorded on the run; only infrastructure errors (the database being
// down) throw, which makes the queue retry the event. A rule that already ran for this event is skipped, so a retry never repeats it.
export async function processEvent(ev: WorkflowEvent & { eventId: string }): Promise<void> {
  const rules = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, ev.organizationId),
        eq(workflows.trigger, ev.event),
        eq(workflows.isActive, true),
        ...(ev.workflowId ? [eq(workflows.id, ev.workflowId)] : []),
      ),
    );
  for (const rule of rules) {
    const [done] = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, rule.id), eq(workflowRuns.eventId, ev.eventId)))
      .limit(1);
    if (done) continue;
    const graph = graphOf(rule);
    const result = graph ? await walk({ workflowId: rule.id, graph, ev }) : invalidRun;
    await recordRun(rule, ev, result, { count: true, eventId: ev.eventId });
  }
}

// Continues a path that was waiting on a delay step.
export async function resumeWorkflow(job: { workflowId: string; organizationId: string; nodeId: string; context: unknown }): Promise<void> {
  const [rule] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, job.workflowId), eq(workflows.organizationId, job.organizationId)))
    .limit(1);
  if (!rule?.isActive) return; // paused or deleted while waiting: drop the run
  const graph = graphOf(rule);
  if (!graph) return;
  const ev = job.context as WorkflowEvent;
  const result = await walk({ workflowId: rule.id, graph, ev, resumeAfter: job.nodeId });
  await recordRun(rule, ev, result, { count: false, eventId: null });
}

// A scheduled run that could not even start (nobody to run it as). Recorded like any failed run, so it shows in the history, sets
// lastError for the editor, and counts toward the automatic pause.
export async function recordSkippedRun(rule: Pick<Rule, 'id' | 'organizationId' | 'name' | 'createdBy' | 'trigger'>, message: string): Promise<void> {
  await recordRun(
    rule,
    { event: rule.trigger },
    { status: 'failed', steps: [{ nodeId: '', type: 'trigger', status: 'failed', error: message }] },
    { count: true, eventId: null },
  );
}
