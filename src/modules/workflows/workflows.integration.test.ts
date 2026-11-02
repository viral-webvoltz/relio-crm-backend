// Workflow engine integration test: queue, dedupe, delay resume, circuit breaker and the update-loop guard, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts a uniquely-named organization and deletes it (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('workflows (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let sqlTag: typeof import('drizzle-orm').sql;
  let eq: typeof import('drizzle-orm').eq;
  let tick: typeof import('./workflows.worker.js').runWorkflowTick;
  let enqueue: typeof import('./workflows.events.js').enqueueWorkflowEvent;
  let processEvent: typeof import('./workflows.engine.js').processEvent;
  let fireDueSchedules: typeof import('./workflows.schedule.js').fireDueSchedules;
  let workflowsServiceRef: typeof import('./workflows.service.js').workflowsService;
  let queueStatus: (organizationId: string) => Promise<{ events: { pending: number; retrying: number }; delayed: { waiting: number } }>;
  let orgId: string;
  let userId: string;

  const pos = { x: 0, y: 0 };
  const node = (id: string, type: string, config: unknown) => ({ id, type, position: pos, config });
  const edge = (source: string, target: string, handle = 'next') => ({ id: `${source}:${handle}->${target}`, source, sourceHandle: handle, target });
  const trigger = (event: string) => node('t', 'trigger', { event });

  async function workflow(name: string, event: string, nodes: unknown[], edges: unknown[]) {
    const [row] = await db.insert(s.workflows).values({ organizationId: orgId, name, trigger: event, graph: { nodes, edges }, createdBy: userId }).returning();
    if (!row) throw new Error('insert failed');
    return row;
  }
  const event = (name: string, values: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    enqueue({ organizationId: orgId, actorId: userId, event: name, id: undefined, values, changed: Object.keys(values), depth: 0, ...extra });
  const runsOf = (workflowId: string) => db.select().from(s.workflowRuns).where(eq(s.workflowRuns.workflowId, workflowId));
  const queued = async () => (await db.select().from(s.workflowEvents).where(eq(s.workflowEvents.organizationId, orgId))).length;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ sql: sqlTag, eq } = await import('drizzle-orm'));
    ({ runWorkflowTick: tick } = await import('./workflows.worker.js'));
    ({ enqueueWorkflowEvent: enqueue } = await import('./workflows.events.js'));
    ({ processEvent } = await import('./workflows.engine.js'));
    ({ fireDueSchedules } = await import('./workflows.schedule.js'));
    ({ workflowsService: workflowsServiceRef } = await import('./workflows.service.js'));
    queueStatus = (id) => workflowsServiceRef.queueStatus(id);

    const tag = crypto.randomUUID().slice(0, 8);
    const [org] = await db
      .insert(s.organizations)
      .values({ name: `wf-${tag}`, slug: `wf-${tag}` })
      .returning();
    if (!org) throw new Error('seed failed');
    orgId = org.id;
    const [user] = await db
      .insert(s.users)
      .values({ organizationId: orgId, email: `wf-${tag}@example.test`, fullName: 'Workflow Tester', passwordHash: 'x' })
      .returning();
    if (!user) throw new Error('seed failed');
    userId = user.id;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId)); // cascades to everything seeded
    await pool.end();
  });

  it('queues an event only when an active workflow listens for it', async () => {
    await event('nothing.listens');
    expect(await queued()).toBe(0);
  });

  it('runs a workflow from the queue: the condition picks the branch and the task is created', async () => {
    const w = await workflow(
      'branching',
      'deals.stage',
      [
        trigger('deals.stage'),
        node('c', 'condition', { mode: 'all', rules: [{ field: 'stage', operator: 'equals', value: 'won' }] }),
        node('k', 'create_task', { title: 'WF onboard {{name}}', priority: 'high', assignTo: 'actor' }),
      ],
      [edge('t', 'c'), edge('c', 'k', 'true')],
    );
    await event('deals.stage', { stage: 'lost', name: 'No' });
    await event('deals.stage', { stage: 'won', name: 'Acme' });
    expect(await queued()).toBe(2);
    await tick();
    expect(await queued()).toBe(0);

    const tasks = await db.select().from(s.tasks).where(eq(s.tasks.organizationId, orgId));
    expect(tasks.map((t) => t.title)).toEqual(['WF onboard Acme']);
    const runs = await runsOf(w.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('does not repeat a run when the same event is delivered twice', async () => {
    const w = await workflow(
      'dedupe',
      'leads.create',
      [trigger('leads.create'), node('n', 'notify', { userId: 'actor', title: 'WF dedupe' })],
      [edge('t', 'n')],
    );
    const ev = {
      eventId: crypto.randomUUID(),
      organizationId: orgId,
      actorId: userId,
      event: 'leads.create',
      id: undefined,
      values: {},
      changed: [],
      depth: 0,
    };
    await processEvent(ev);
    await processEvent(ev); // a redelivery after a crash or an expired lease
    expect(await runsOf(w.id)).toHaveLength(1);
    const notes = await db.select().from(s.notifications).where(eq(s.notifications.organizationId, orgId));
    expect(notes.filter((n) => n.title === 'WF dedupe')).toHaveLength(1);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('parks a path on a delay and finishes it when the time comes', async () => {
    const w = await workflow(
      'delayed',
      'tasks.create',
      [trigger('tasks.create'), node('d', 'delay', { amount: 1, unit: 'minutes' }), node('n', 'notify', { userId: 'actor', title: 'WF after delay' })],
      [edge('t', 'd'), edge('d', 'n')],
    );
    await event('tasks.create', { title: 'x' });
    await tick();
    expect((await runsOf(w.id)).map((r) => r.status)).toEqual(['waiting']);
    const before = await db.select().from(s.notifications).where(eq(s.notifications.organizationId, orgId));
    expect(before.some((n) => n.title === 'WF after delay')).toBe(false);

    await db.execute(sqlTag`update workflow_jobs set run_at = now() - interval '1 second' where workflow_id = ${w.id}`);
    await tick();
    const runs = await runsOf(w.id);
    expect(runs.map((r) => r.status).sort()).toEqual(['success', 'waiting']);
    const after = await db.select().from(s.notifications).where(eq(s.notifications.organizationId, orgId));
    expect(after.some((n) => n.title === 'WF after delay')).toBe(true);
    expect(await db.select().from(s.workflowJobs).where(eq(s.workflowJobs.workflowId, w.id))).toHaveLength(0);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('pauses a workflow after 10 failures in a row and tells its creator', async () => {
    // localhost resolves to loopback, which the pinned lookup refuses: a fast, offline, permanent failure.
    const w = await workflow(
      'broken',
      'companies.create',
      [trigger('companies.create'), node('h', 'http_request', { method: 'POST', url: 'https://localhost:1/hook' })],
      [edge('t', 'h')],
    );
    for (let i = 0; i < 10; i++) {
      await event('companies.create', { name: `c${i}` });
      await tick();
    }
    const [row] = await db.select().from(s.workflows).where(eq(s.workflows.id, w.id));
    expect(row?.isActive).toBe(false);
    expect(row?.consecutiveFailures).toBe(10);
    expect(row?.lastError).toMatch(/private or reserved/);
    const notes = await db.select().from(s.notifications).where(eq(s.notifications.userId, userId));
    expect(notes.some((n) => n.title.includes('was paused'))).toBe(true);

    await event('companies.create', { name: 'after' }); // paused: nothing is queued any more
    expect(await queued()).toBe(0);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('stops two workflows that keep re-triggering each other', async () => {
    const [lead] = await db.insert(s.leads).values({ organizationId: orgId, firstName: 'Loop' }).returning();
    if (!lead) throw new Error('seed failed');
    const flip = (name: string, from: string, to: string) =>
      workflow(
        name,
        'leads.update',
        [
          trigger('leads.update'),
          node('c', 'condition', { mode: 'all', rules: [{ field: 'priority', operator: 'equals', value: from }] }),
          node('u', 'update_record', { field: 'priority', value: to }),
        ],
        [edge('t', 'c'), edge('c', 'u', 'true')],
      );
    const a = await flip('low to high', 'low', 'high');
    const b = await flip('high to low', 'high', 'low');

    await enqueue({ organizationId: orgId, actorId: userId, event: 'leads.update', id: lead.id, values: { priority: 'low' }, changed: ['priority'], depth: 0 });
    for (let i = 0; i < 30 && (await queued()) > 0; i++) await tick();

    expect(await queued()).toBe(0); // it ended
    const runs = [...(await runsOf(a.id)), ...(await runsOf(b.id))];
    expect(runs.length).toBeGreaterThan(2);
    expect(runs.length).toBeLessThanOrEqual(10); // 5 levels of depth, two workflows each
    await db.delete(s.workflows).where(eq(s.workflows.organizationId, orgId));
  });

  it('refuses to change a field outside the whitelist even if a stored graph asks for it', async () => {
    const [lead] = await db.insert(s.leads).values({ organizationId: orgId, firstName: 'Guard', score: 1 }).returning();
    if (!lead) throw new Error('seed failed');
    const w = await workflow(
      'sneaky',
      'leads.update',
      [trigger('leads.update'), node('u', 'update_record', { field: 'score', value: '999' })],
      [edge('t', 'u')],
    );
    await enqueue({ organizationId: orgId, actorId: userId, event: 'leads.update', id: lead.id, values: {}, changed: [], depth: 0 });
    await tick();
    const [after] = await db.select().from(s.leads).where(eq(s.leads.id, lead.id));
    expect(after?.score).toBe(1);
    expect((await runsOf(w.id))[0]?.status).toBe('failed');
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  const notes = async (title: string) =>
    (await db.select().from(s.notifications).where(eq(s.notifications.organizationId, orgId))).filter((n) => n.title === title).length;

  it('fires a daily schedule once per day, at its time, and not before', async () => {
    const w = await workflow(
      'daily',
      'schedule.daily',
      [node('t', 'trigger', { event: 'schedule.daily', at: '14:30' }), node('n', 'notify', { userId: 'actor', title: 'WF daily {{date}}' })],
      [edge('t', 'n')],
    );
    expect(await fireDueSchedules(new Date('2026-03-03T14:29:00Z'))).toBe(0);
    expect(await fireDueSchedules(new Date('2026-03-03T14:30:00Z'))).toBe(1);
    expect(await fireDueSchedules(new Date('2026-03-03T18:00:00Z'))).toBe(0); // already fired today
    await tick();
    expect(await notes('WF daily 2026-03-03')).toBe(1);
    expect(await fireDueSchedules(new Date('2026-03-04T14:30:00Z'))).toBe(1); // next day
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('fires a weekly schedule on Mondays only', async () => {
    const w = await workflow(
      'weekly',
      'schedule.weekly',
      [trigger('schedule.weekly'), node('n', 'notify', { userId: 'actor', title: 'WF weekly' })],
      [edge('t', 'n')],
    );
    expect(await fireDueSchedules(new Date('2026-03-03T10:00:00Z'))).toBe(0); // Tuesday
    expect(await fireDueSchedules(new Date('2026-03-02T10:00:00Z'))).toBe(1); // Monday, default 09:00
    await tick();
    expect(await notes('WF weekly')).toBe(1);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('fires an overdue trigger once per record, only for recently overdue ones, and never repeats', async () => {
    await db.insert(s.tasks).values([
      { organizationId: orgId, title: 'T-recent', dueDate: '2026-03-09' },
      { organizationId: orgId, title: 'T-ancient', dueDate: '2026-02-18' },
      { organizationId: orgId, title: 'T-future', dueDate: '2026-03-12' },
      { organizationId: orgId, title: 'T-done', dueDate: '2026-03-08', status: 'done' },
    ]);
    const w = await workflow(
      'overdue',
      'tasks.overdue',
      [trigger('tasks.overdue'), node('n', 'notify', { userId: 'actor', title: 'WF overdue {{title}}' })],
      [edge('t', 'n')],
    );
    expect(await fireDueSchedules(new Date('2026-03-10T09:00:00Z'))).toBe(1);
    await tick();
    expect(await notes('WF overdue T-recent')).toBe(1);
    expect(await notes('WF overdue T-ancient')).toBe(0);
    expect(await notes('WF overdue T-future')).toBe(0);
    expect(await notes('WF overdue T-done')).toBe(0);

    await fireDueSchedules(new Date('2026-03-11T09:00:00Z')); // the next day it is still overdue, but it already fired
    await tick();
    expect(await notes('WF overdue T-recent')).toBe(1);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('reports the backlog for the organization', async () => {
    const w = await workflow(
      'queue',
      'leads.convert',
      [trigger('leads.convert'), node('n', 'notify', { userId: 'actor', title: 'WF queue' })],
      [edge('t', 'n')],
    );
    await event('leads.convert', {});
    expect((await queueStatus(orgId)).events.pending).toBe(1);
    await tick();
    expect((await queueStatus(orgId)).events.pending).toBe(0);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('runs a schedule on the wall clock of its own timezone', async () => {
    // 09:00 in Kolkata (UTC+5:30) is 03:30 UTC.
    const w = await workflow(
      'kolkata',
      'schedule.daily',
      [node('t', 'trigger', { event: 'schedule.daily', timezone: 'Asia/Kolkata' }), node('n', 'notify', { userId: 'actor', title: 'WF kolkata {{date}}' })],
      [edge('t', 'n')],
    );
    expect(await fireDueSchedules(new Date('2026-04-07T03:29:00Z'))).toBe(0);
    expect(await fireDueSchedules(new Date('2026-04-07T03:30:00Z'))).toBe(1);
    await tick();
    expect(await notes('WF kolkata 2026-04-07')).toBe(1);

    // 22:00 UTC is already the next calendar day in Kolkata, but only 03:30 there: not yet 09:00, so nothing fires until 03:30 UTC.
    expect(await fireDueSchedules(new Date('2026-04-07T22:00:00Z'))).toBe(0);
    expect(await fireDueSchedules(new Date('2026-04-08T03:30:00Z'))).toBe(1);
    await tick();
    expect(await notes('WF kolkata 2026-04-08')).toBe(1);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('lets a weekly schedule pick its weekday', async () => {
    const w = await workflow(
      'friday',
      'schedule.weekly',
      [node('t', 'trigger', { event: 'schedule.weekly', day: 'fri' }), node('n', 'notify', { userId: 'actor', title: 'WF friday' })],
      [edge('t', 'n')],
    );
    expect(await fireDueSchedules(new Date('2026-03-09T10:00:00Z'))).toBe(0); // Monday
    expect(await fireDueSchedules(new Date('2026-03-13T10:00:00Z'))).toBe(1); // Friday
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('fires invoices.overdue for unpaid invoices that just fell due, not paid or ancient ones', async () => {
    const mk = async (n: number, dueDate: string, status: string) => {
      const [order] = await db.insert(s.orders).values({ organizationId: orgId, orderNumber: n, currency: 'USD' }).returning();
      if (!order) throw new Error('seed failed');
      await db
        .insert(s.invoices)
        .values({ organizationId: orgId, invoiceNumber: n, orderId: order.id, currency: 'USD', dueDate, status, customerName: `Cust${n}` });
    };
    await mk(9001, '2026-03-09', 'unpaid');
    await mk(9002, '2026-03-09', 'paid');
    await mk(9003, '2026-02-01', 'unpaid');
    await mk(9004, '2026-03-20', 'unpaid');
    const w = await workflow(
      'inv overdue',
      'invoices.overdue',
      [trigger('invoices.overdue'), node('n', 'notify', { userId: 'actor', title: 'WF invoice {{invoiceNumber}} {{customerName}}' })],
      [edge('t', 'n')],
    );
    expect(await fireDueSchedules(new Date('2026-03-10T09:00:00Z'))).toBe(1);
    await tick();
    expect(await notes('WF invoice 9001 Cust9001')).toBe(1);
    expect(await notes('WF invoice 9002 Cust9002')).toBe(0);
    expect(await notes('WF invoice 9003 Cust9003')).toBe(0);
    expect(await notes('WF invoice 9004 Cust9004')).toBe(0);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  // A second user, optionally an admin (settings.manage), for the "creator is gone" cases.
  async function person(label: string, { admin }: { admin: boolean }) {
    const [u] = await db
      .insert(s.users)
      .values({ organizationId: orgId, email: `${label}-${crypto.randomUUID().slice(0, 6)}@example.test`, fullName: label, passwordHash: 'x' })
      .returning();
    if (!u) throw new Error('seed failed');
    if (admin) {
      await db.insert(s.permissions).values({ key: 'settings.manage' }).onConflictDoNothing();
      const [perm] = await db.select().from(s.permissions).where(eq(s.permissions.key, 'settings.manage'));
      const [role] = await db
        .insert(s.roles)
        .values({ organizationId: orgId, name: `admin-${label}-${crypto.randomUUID().slice(0, 6)}` })
        .returning();
      if (!perm || !role) throw new Error('seed failed');
      await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: perm.id });
      await db.insert(s.userRoles).values({ userId: u.id, roleId: role.id });
    }
    return u;
  }
  const scheduled = async (createdBy: string, title: string) => {
    const [row] = await db
      .insert(s.workflows)
      .values({
        organizationId: orgId,
        name: title,
        trigger: 'schedule.daily',
        createdBy,
        graph: { nodes: [trigger('schedule.daily'), node('n', 'notify', { userId: 'actor', title })], edges: [edge('t', 'n')] },
      })
      .returning();
    if (!row) throw new Error('insert failed');
    return row;
  };
  const noteFor = async (title: string) =>
    (await db.select().from(s.notifications).where(eq(s.notifications.organizationId, orgId))).find((n) => n.title === title);

  it('runs a schedule as an active admin when its creator was deactivated, and says so in the API', async () => {
    const gone = await person('gone-user', { admin: false });
    const admin = await person('stand-in', { admin: true });
    const w = await scheduled(gone.id, 'WF orphan fallback');
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, gone.id));

    const listed = (await workflowsServiceRef.list(orgId)).find((x) => x.id === w.id);
    expect(listed?.runsAs).toMatchObject({ problem: 'inactive', creator: { id: gone.id }, willRunAs: { id: admin.id } });

    expect(await fireDueSchedules(new Date('2026-05-05T09:00:00Z'))).toBe(1);
    await tick();
    expect((await noteFor('WF orphan fallback'))?.userId).toBe(admin.id); // ran as the stand-in, not skipped
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
    await db.delete(s.users).where(eq(s.users.id, admin.id)); // so the next case has no admin
  });

  it('records a failed run, not a silent skip, when nobody can run a schedule', async () => {
    const gone = await person('lonely', { admin: false });
    const w = await scheduled(gone.id, 'WF nobody');
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, gone.id));

    const listed = (await workflowsServiceRef.list(orgId)).find((x) => x.id === w.id);
    expect(listed?.runsAs).toMatchObject({ problem: 'inactive', willRunAs: null });

    await fireDueSchedules(new Date('2026-05-06T09:00:00Z'));
    const [run] = await runsOf(w.id);
    expect(run?.status).toBe('failed');
    expect(JSON.stringify(run?.steps)).toMatch(/Run as me/);
    const [row] = await db.select().from(s.workflows).where(eq(s.workflows.id, w.id));
    expect(row?.lastError).toMatch(/Nobody is available/);
    expect(await noteFor('WF nobody')).toBeUndefined();
    // Nobody can run it, so the organization's active users are told (a stand-in, or at least someone who can escalate it).
    expect((await noteFor('Workflow "WF nobody" could not run'))?.userId).toBe(userId);

    // "Run as me": the caller takes over, the failure streak resets, and the schedule is healthy again.
    await db.update(s.users).set({ isActive: true }).where(eq(s.users.id, userId));
    const updated = await workflowsServiceRef.update({ organizationId: orgId, userId, id: w.id, input: { runAsMe: true } });
    expect(updated.runsAs).toMatchObject({ problem: null, willRunAs: { id: userId } });
    expect(updated.consecutiveFailures).toBe(0);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('shows no run-as information for workflows that react to user actions', async () => {
    const w = await workflow('plain', 'leads.create', [trigger('leads.create')], []);
    expect((await workflowsServiceRef.list(orgId)).find((x) => x.id === w.id)?.runsAs).toBeNull();
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
  });

  it('notifies an active admin when a workflow of a departed creator is paused after repeated failures', async () => {
    const gone = await person('departed', { admin: false });
    const admin = await person('on-call', { admin: true });
    const [w] = await db
      .insert(s.workflows)
      .values({
        organizationId: orgId,
        name: 'WF departed broken',
        trigger: 'contacts.create',
        createdBy: gone.id,
        graph: { nodes: [trigger('contacts.create'), node('h', 'http_request', { method: 'POST', url: 'https://localhost:1/hook' })], edges: [edge('t', 'h')] },
      })
      .returning();
    if (!w) throw new Error('insert failed');
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, gone.id));
    for (let i = 0; i < 10; i++) {
      await event('contacts.create', { n: i });
      await tick();
    }
    const [row] = await db.select().from(s.workflows).where(eq(s.workflows.id, w.id));
    expect(row?.isActive).toBe(false);
    expect((await noteFor('Workflow "WF departed broken" was paused'))?.userId).toBe(admin.id);
    await db.delete(s.workflows).where(eq(s.workflows.id, w.id));
    await db.delete(s.users).where(eq(s.users.id, admin.id));
  });

  it('never notifies the same person twice for the same dedupe key', async () => {
    const { notifyWorkflowOwners } = await import('./workflows.runas.js');
    const send = () => notifyWorkflowOwners({ organizationId: orgId, createdBy: userId, title: 'WF dedupe note', body: 'x', dedupeKey: `wf-test:${orgId}` });
    await send();
    await send();
    expect(await notes('WF dedupe note')).toBe(1);
  });

  it('uses the organization timezone for schedules that do not set their own, and reports it', async () => {
    try {
      await workflowsServiceRef.updateSettings({ organizationId: orgId, input: { timezone: 'Asia/Kolkata' } });
      expect(await workflowsServiceRef.getSettings(orgId)).toEqual({ timezone: 'Asia/Kolkata' });
      expect((await workflowsServiceRef.meta(orgId)).timezone).toBe('Asia/Kolkata');

      const inherits = await workflow(
        'inherits',
        'schedule.daily',
        [trigger('schedule.daily'), node('n', 'notify', { userId: 'actor', title: 'WF org-tz {{date}}' })],
        [edge('t', 'n')],
      );
      const own = await workflow(
        'own tz',
        'schedule.daily',
        [node('t', 'trigger', { event: 'schedule.daily', timezone: 'UTC' }), node('n', 'notify', { userId: 'actor', title: 'WF own-tz {{date}}' })],
        [edge('t', 'n')],
      );

      const listed = await workflowsServiceRef.list(orgId);
      expect(listed.find((x) => x.id === inherits.id)?.schedule).toEqual({ timezone: 'Asia/Kolkata', timezoneSource: 'organization', at: '09:00', day: null });
      expect(listed.find((x) => x.id === own.id)?.schedule).toMatchObject({ timezone: 'UTC', timezoneSource: 'workflow' });

      // 03:30 UTC is 09:00 in Kolkata: the inheriting workflow is due, the UTC one is not (it waits for 09:00 UTC).
      expect(await fireDueSchedules(new Date('2026-06-09T03:29:00Z'))).toBe(0);
      expect(await fireDueSchedules(new Date('2026-06-09T03:30:00Z'))).toBe(1);
      expect(await fireDueSchedules(new Date('2026-06-09T09:00:00Z'))).toBe(1);
      await tick();
      expect(await notes('WF org-tz 2026-06-09')).toBe(1);
      expect(await notes('WF own-tz 2026-06-09')).toBe(1);
      await db.delete(s.workflows).where(eq(s.workflows.id, inherits.id));
      await db.delete(s.workflows).where(eq(s.workflows.id, own.id));
    } finally {
      await workflowsServiceRef.updateSettings({ organizationId: orgId, input: { timezone: 'UTC' } });
    }
  });
});
