// SLA integration test: policy, deadlines, first response, the escalation scan and the summary, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('SLA (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let support: typeof import('./support.service.js').supportService;
  let sla: typeof import('./sla.service.js').slaService;
  let scanSla: typeof import('./sla.scheduler.js').scanSla;
  let orgId: string;
  let otherOrgId: string;
  let agentId: string;
  let adminId: string;

  const minutes = (n: number) => new Date(Date.now() + n * 60_000);
  const policy = (extra: Record<string, unknown> = {}) => ({
    targets: {
      urgent: { firstResponseMinutes: 30, resolutionMinutes: 240 },
      high: { firstResponseMinutes: 120, resolutionMinutes: 1440 },
      medium: { firstResponseMinutes: 480, resolutionMinutes: 4320 },
      low: { firstResponseMinutes: 1440, resolutionMinutes: 7200 },
    },
    businessHours: null,
    warnAtPercent: 80,
    applyToOpen: false,
    ...extra,
  });
  const ticket = (priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium', assignedTo: string | null = agentId) =>
    support.createTicket({
      organizationId: orgId,
      userId: adminId,
      input: { subject: `t-${crypto.randomUUID().slice(0, 6)}`, body: 'Help', priority, assignedTo } as never,
    });
  const reload = async (id: string) => (await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id)))[0]!;
  const set = (id: string, values: Partial<typeof s.supportTickets.$inferInsert>) => db.update(s.supportTickets).set(values).where(eq(s.supportTickets.id, id));
  const alertsFor = (ticketId: string, userId?: string) =>
    db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.relatedId, ticketId), eq(s.notifications.type, 'ticket_sla'), userId ? eq(s.notifications.userId, userId) : undefined));
  const code = async (work: Promise<unknown>) =>
    (
      (await work.then(
        () => null,
        (err: unknown) => err,
      )) as { code?: string } | null
    )?.code;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
    ({ supportService: support } = await import('./support.service.js'));
    ({ slaService: sla } = await import('./sla.service.js'));
    ({ scanSla } = await import('./sla.scheduler.js'));

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `sla-${tag}`, slug: `sla-${tag}` },
        { name: `sla2-${tag}`, slug: `sla2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    const [agent, admin] = await db
      .insert(s.users)
      .values([
        { organizationId: orgId, email: `agent-${tag}@example.test`, fullName: 'Agent', passwordHash: 'x' },
        { organizationId: orgId, email: `admin-${tag}@example.test`, fullName: 'Admin', passwordHash: 'x' },
      ])
      .returning();
    agentId = agent!.id;
    adminId = admin!.id;
    await db.insert(s.permissions).values({ key: 'settings.manage' }).onConflictDoNothing();
    const [perm] = await db.select().from(s.permissions).where(eq(s.permissions.key, 'settings.manage'));
    const [role] = await db
      .insert(s.roles)
      .values({ organizationId: orgId, name: `admin-${tag}` })
      .returning();
    await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionId: perm!.id });
    await db.insert(s.userRoles).values({ userId: adminId, roleId: role!.id });
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('starts from sensible defaults and sets both deadlines on a new ticket', async () => {
    expect(await sla.getPolicy(orgId)).toMatchObject({ isDefault: true, warnAtPercent: 80, businessHours: null });
    const t = await ticket('urgent');
    // created_at comes from the database clock and the deadline from the app clock, so allow a few seconds of difference
    expect(Math.abs(t.firstResponseDueAt!.getTime() - t.createdAt.getTime() - 30 * 60_000)).toBeLessThan(5_000);
    expect(Math.abs(t.slaDueAt.getTime() - t.createdAt.getTime() - 4 * 3_600_000)).toBeLessThan(5_000);
  });

  it('saves a policy, rejects an inconsistent one, and keeps organizations apart', async () => {
    const saved = await sla.putPolicy({ organizationId: orgId, userId: adminId, input: policy({ warnAtPercent: 70 }) as never });
    expect(saved).toMatchObject({ isDefault: false, warnAtPercent: 70, ticketsMoved: 0 });
    expect((await sla.getPolicy(orgId)).targets.urgent.resolutionMinutes).toBe(240);
    expect((await sla.getPolicy(otherOrgId)).isDefault).toBe(true);
    const { slaPolicySchema } = await import('./sla.validation.js');
    const bad = policy();
    bad.targets.high = { firstResponseMinutes: 2000, resolutionMinutes: 60 };
    expect(slaPolicySchema.safeParse(bad).success).toBe(false);
    expect(slaPolicySchema.safeParse(policy({ businessHours: { timezone: 'Nowhere/Land', days: [1], start: '09:00', end: '17:00' } })).success).toBe(false);
    expect(slaPolicySchema.safeParse(policy({ businessHours: { timezone: 'UTC', days: [1], start: '17:00', end: '09:00' } })).success).toBe(false);
  });

  it('counts business hours into the deadlines of new tickets', async () => {
    await sla.putPolicy({
      organizationId: orgId,
      userId: adminId,
      input: policy({ businessHours: { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' } }) as never,
    });
    // Friday 16:00 UTC, urgent (4 working hours): 1h on Friday + 3h on Monday = Monday 12:00
    const due = await sla.dueFor(orgId, 'urgent', new Date('2026-11-06T16:00:00Z'));
    expect(due.slaDueAt.toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(due.firstResponseDueAt.toISOString()).toBe('2026-11-06T16:30:00.000Z');
    await sla.putPolicy({ organizationId: orgId, userId: adminId, input: policy({ warnAtPercent: 80 }) as never }); // back to round-the-clock
  });

  it('moves open tickets to a new policy only on request, and leaves old tickets without a first-reply target', async () => {
    const withTarget = await ticket('high');
    const old = await ticket('high');
    await set(old.id, { firstResponseDueAt: null });
    const tight = policy({ applyToOpen: true });
    tight.targets.high = { firstResponseMinutes: 10, resolutionMinutes: 60 };

    await sla.putPolicy({ organizationId: orgId, userId: adminId, input: { ...tight, applyToOpen: false } as never });
    expect((await reload(withTarget.id)).slaDueAt).toEqual(withTarget.slaDueAt); // not touched
    const saved = await sla.putPolicy({ organizationId: orgId, userId: adminId, input: tight as never });
    expect(saved.ticketsMoved).toBeGreaterThanOrEqual(2);
    const moved = await reload(withTarget.id);
    expect(moved.slaDueAt.getTime() - moved.createdAt.getTime()).toBe(60 * 60_000);
    expect(moved.firstResponseDueAt!.getTime() - moved.createdAt.getTime()).toBe(10 * 60_000);
    expect((await reload(old.id)).firstResponseDueAt).toBeNull();
    await sla.putPolicy({ organizationId: orgId, userId: adminId, input: policy() as never });
  });

  it('records the first customer-visible reply, and not an internal note', async () => {
    const t = await ticket('medium');
    await support.addMessage({ organizationId: orgId, userId: agentId, id: t.id, input: { body: 'note to self', isInternal: true } as never });
    expect((await reload(t.id)).firstRespondedAt).toBeNull();
    await support.addMessage({ organizationId: orgId, userId: agentId, id: t.id, input: { body: 'Hello!', isInternal: false } as never });
    const first = (await reload(t.id)).firstRespondedAt;
    expect(first).not.toBeNull();
    await support.addMessage({ organizationId: orgId, userId: agentId, id: t.id, input: { body: 'More', isInternal: false } as never });
    expect((await reload(t.id)).firstRespondedAt).toEqual(first); // only the first one counts
  });

  it('shows the SLA state on the ticket and in the list', async () => {
    const t = await ticket('medium');
    const detail = await support.getTicket(orgId, t.id);
    expect(detail.sla).toMatchObject({ resolution: { state: 'ok' }, firstResponse: { state: 'ok', respondedAt: null } });
    await set(t.id, { slaDueAt: minutes(-5) });
    expect((await support.getTicket(orgId, t.id)).sla.resolution.state).toBe('breached');
    await set(t.id, { status: 'pending' });
    expect((await support.getTicket(orgId, t.id)).sla.resolution.state).toBe('paused');
    const listed = await support.listTickets({ organizationId: orgId, userId: adminId, query: { page: 1, limit: 100 } as never });
    expect(listed.rows.find((r) => r.id === t.id)?.sla.resolution.state).toBe('paused');
  });

  it('a priority change recomputes the deadlines and re-arms the alerts', async () => {
    const t = await ticket('low');
    await set(t.id, { slaWarnedAt: new Date(), slaBreachNotifiedAt: new Date() });
    const changed = await support.updateTicket({ organizationId: orgId, id: t.id, input: { priority: 'urgent' } as never, actorId: adminId });
    expect(changed.slaDueAt.getTime() - changed.createdAt.getTime()).toBe(4 * 3_600_000);
    const row = await reload(t.id);
    expect(row.slaWarnedAt).toBeNull();
    expect(row.slaBreachNotifiedAt).toBeNull();
  });

  it('warns the owner once as a deadline approaches', async () => {
    const t = await ticket('high');
    await set(t.id, { createdAt: minutes(-90), slaDueAt: minutes(10), firstResponseDueAt: null }); // 90% of the way
    const first = await scanSla();
    expect(first.sla_warning).toBeGreaterThanOrEqual(1);
    const alerts = await alertsFor(t.id);
    expect(alerts.map((a) => [a.userId, a.title])).toEqual([[agentId, `Ticket #${t.ticketNumber} is close to its SLA deadline`]]); // owner only, not the admin
    await scanSla();
    expect(await alertsFor(t.id)).toHaveLength(1); // not again
  });

  it('raises a breach to the owner and the admins once, and not for a ticket waiting on the customer', async () => {
    const late = await ticket('high');
    await set(late.id, { createdAt: minutes(-200), slaDueAt: minutes(-5), firstResponseDueAt: null, slaWarnedAt: new Date() });
    const waiting = await ticket('high');
    await set(waiting.id, { status: 'pending', createdAt: minutes(-200), slaDueAt: minutes(-5), firstResponseDueAt: null });

    await scanSla();
    const alerts = await alertsFor(late.id);
    expect(alerts.map((a) => a.userId).sort()).toEqual([adminId, agentId].sort());
    expect(alerts[0]!.title).toBe(`Ticket #${late.ticketNumber} breached its SLA`);
    expect(await alertsFor(waiting.id)).toHaveLength(0);
    expect((await reload(late.id)).slaBreachNotifiedAt).not.toBeNull();
    await scanSla();
    expect(await alertsFor(late.id)).toHaveLength(2);
  });

  it('raises a missed first reply, but not once someone has replied', async () => {
    const silent = await ticket('urgent');
    await set(silent.id, { createdAt: minutes(-60), firstResponseDueAt: minutes(-30) });
    const answered = await ticket('urgent');
    await set(answered.id, { createdAt: minutes(-60), firstResponseDueAt: minutes(-30), firstRespondedAt: minutes(-45) });
    await scanSla();
    expect((await alertsFor(silent.id)).map((a) => a.title)).toContain(`Ticket #${silent.ticketNumber} has no reply past its first-response target`);
    expect(await alertsFor(answered.id)).toHaveLength(0);
  });

  it('an unowned ticket escalates to the admins', async () => {
    const t = await ticket('high', null);
    await set(t.id, { createdAt: minutes(-90), slaDueAt: minutes(10), firstResponseDueAt: null });
    await scanSla();
    expect((await alertsFor(t.id)).map((a) => a.userId)).toEqual([adminId]);
  });

  it('feeds workflows and webhooks: a breach event is queued for an active workflow on it', async () => {
    await db.insert(s.workflows).values({
      organizationId: orgId,
      name: 'on breach',
      trigger: 'tickets.sla_breached',
      graph: { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'tickets.sla_breached' } }], edges: [] },
      createdBy: adminId,
    });
    const t = await ticket('high');
    await set(t.id, { createdAt: minutes(-200), slaDueAt: minutes(-5), firstResponseDueAt: null });
    await scanSla();
    const events = await db
      .select()
      .from(s.workflowEvents)
      .where(and(eq(s.workflowEvents.organizationId, orgId), eq(s.workflowEvents.recordId, t.id)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'tickets.sla_breached', actorId: agentId });
    expect(events[0]!.values).toMatchObject({ ticketNumber: t.ticketNumber, priority: 'high' });
  });

  it('summarises compliance and what needs attention now', async () => {
    const t = await ticket('urgent');
    await set(t.id, { status: 'resolved', resolvedAt: new Date(t.slaDueAt.getTime() - 1000), firstRespondedAt: new Date(t.createdAt.getTime() + 60_000) });
    const missed = await ticket('urgent');
    await set(missed.id, { status: 'resolved', resolvedAt: new Date(missed.slaDueAt.getTime() + 1000) });
    const summary = await sla.summary({ organizationId: orgId, days: 30 });
    expect(summary.tickets).toBeGreaterThan(5);
    expect(summary.now.breached).toBeGreaterThanOrEqual(1);
    const urgent = summary.byPriority.find((p) => p.priority === 'urgent')!;
    expect(urgent.resolved).toBeGreaterThanOrEqual(2);
    expect(urgent.resolutionRate).toBeLessThan(100);
    expect(urgent.avgFirstResponseMinutes).toBeGreaterThan(0); // averaged over every urgent ticket that got a reply
    expect(await code(sla.summary({ organizationId: otherOrgId, days: 30 }).then((r) => (r.tickets === 0 ? Promise.reject({ code: 'EMPTY' }) : r)))).toBe(
      'EMPTY',
    ); // nothing leaks across
  });
});
