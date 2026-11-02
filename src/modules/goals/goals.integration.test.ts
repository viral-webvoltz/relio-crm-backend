// Goals integration test: every metric counted from live data, scopes, timezone-exact periods and the leaderboard, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('goals (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let svc: typeof import('./goals.service.js').goalsService;
  let schemas: typeof import('./goals.validation.js');
  let orgId: string;
  let otherOrgId: string;
  let alice: string;
  let bob: string;
  let carol: string; // inactive
  let teamId: string;
  let wonStage: string;
  let openStage: string;
  let pipelineId: string;
  let counter = 5000;

  // A period far enough in the past to be stable, and its dates.
  const MARCH = { startDate: '2026-03-01', endDate: '2026-03-31' };
  const inMarch = new Date('2026-03-15T12:00:00Z');
  const goal = (extra: Record<string, unknown> = {}) =>
    svc.create({
      organizationId: orgId,
      userId: alice,
      input: { name: 'g', metric: 'deals_won', scope: { type: 'organization' }, period: 'custom', ...MARCH, target: 10, ...extra } as never,
    });
  const progressOf = async (id: string) => (await svc.getById({ organizationId: orgId, id })).progress;
  const deal = (ownerId: string | null, extra: Record<string, unknown> = {}) =>
    db.insert(s.deals).values({
      organizationId: orgId,
      pipelineId,
      stageId: wonStage,
      title: 'd',
      valueMinor: 1000,
      currency: 'USD',
      ownerId,
      createdAt: inMarch,
      updatedAt: inMarch,
      ...extra,
    } as never);
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
    ({ eq } = await import('drizzle-orm'));
    ({ goalsService: svc } = await import('./goals.service.js'));
    schemas = await import('./goals.validation.js');

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `g-${tag}`, slug: `g-${tag}` },
        { name: `g2-${tag}`, slug: `g2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    const rows = await db
      .insert(s.users)
      .values(
        ['alice', 'bob', 'carol'].map((n) => ({
          organizationId: orgId,
          email: `${n}-${tag}@example.test`,
          fullName: n,
          passwordHash: 'x',
          isActive: n !== 'carol',
        })),
      )
      .returning();
    [alice, bob, carol] = rows.map((r) => r.id) as [string, string, string];
    teamId = (await db.insert(s.teams).values({ organizationId: orgId, name: 'Team A' }).returning())[0]!.id;
    await db.insert(s.teamMembers).values([{ teamId, userId: alice, organizationId: orgId }]);
    pipelineId = (await db.insert(s.pipelines).values({ organizationId: orgId, name: 'P' }).returning())[0]!.id;
    const stages = await db
      .insert(s.pipelineStages)
      .values([
        { organizationId: orgId, pipelineId, name: 'Open', position: 0, kind: 'open' },
        { organizationId: orgId, pipelineId, name: 'Won', position: 1, kind: 'won' },
      ])
      .returning();
    openStage = stages[0]!.id;
    wonStage = stages[1]!.id;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('validates a goal: money needs a currency, custom needs dates, and the measuring stick cannot be edited', () => {
    const ok = { name: 'x', metric: 'revenue_won', scope: { type: 'organization' }, period: 'month', target: 5, currency: 'usd' };
    expect(schemas.createGoalSchema.safeParse(ok).success).toBe(true);
    expect(schemas.createGoalSchema.parse(ok).currency).toBe('USD');
    expect(schemas.createGoalSchema.safeParse({ ...ok, currency: undefined }).success).toBe(false);
    expect(schemas.createGoalSchema.safeParse({ ...ok, metric: 'deals_won' }).success).toBe(false); // a count has no currency
    expect(schemas.createGoalSchema.safeParse({ ...ok, period: 'custom' }).success).toBe(false);
    expect(schemas.createGoalSchema.safeParse({ ...ok, period: 'custom', startDate: '2026-03-05', endDate: '2026-03-01' }).success).toBe(false);
    expect(schemas.createGoalSchema.safeParse({ ...ok, startDate: '2026-03-01' }).success).toBe(false); // dates only for custom
    expect(schemas.updateGoalSchema.safeParse({ metric: 'deals_won' }).success).toBe(false);
    expect(schemas.updateGoalSchema.safeParse({ target: 20 }).success).toBe(true);
  });

  it('derives the period from any day inside it, and checks the scope belongs to the organization', async () => {
    const g = await goal({ period: 'quarter', startDate: undefined, endDate: undefined, on: '2026-05-20' });
    expect(g).toMatchObject({ startDate: '2026-04-01', endDate: '2026-06-30', periodType: 'quarter', scopeType: 'organization' });
    expect(await code(goal({ scope: { type: 'user', userId: carol } }))).toBe('INVALID_SCOPE'); // inactive
    expect(await code(goal({ scope: { type: 'user', userId: crypto.randomUUID() } }))).toBe('INVALID_SCOPE');
    expect(await code(goal({ scope: { type: 'team', teamId: crypto.randomUUID() } }))).toBe('INVALID_SCOPE');
  });

  it('counts won deals per scope, ignoring open stages, other periods, deleted deals and other currencies', async () => {
    await deal(alice, { valueMinor: 4000 });
    await deal(alice, { valueMinor: 6000 });
    await deal(bob, { valueMinor: 500 });
    await deal(alice, { stageId: openStage, valueMinor: 9999 }); // not won
    await deal(alice, { updatedAt: new Date('2026-04-02T00:00:00Z'), valueMinor: 9999 }); // outside March
    await deal(alice, { deletedAt: inMarch, valueMinor: 9999 }); // deleted
    await deal(alice, { currency: 'EUR', valueMinor: 7777 }); // other currency

    const org = await goal({ metric: 'revenue_won', currency: 'USD', target: 20_000 });
    expect(await progressOf(org.id)).toMatchObject({ actual: 10_500, target: 20_000, percent: 53, state: 'missed', remaining: 9500 });
    const mine = await goal({ metric: 'revenue_won', currency: 'USD', scope: { type: 'user', userId: alice }, target: 10_000 });
    expect(await progressOf(mine.id)).toMatchObject({ actual: 10_000, state: 'achieved' });
    const count = await goal({ metric: 'deals_won', scope: { type: 'user', userId: bob }, target: 1 });
    expect(await progressOf(count.id)).toMatchObject({ actual: 1, state: 'achieved' });
    const eur = await goal({ metric: 'revenue_won', currency: 'EUR', target: 10_000 });
    expect((await progressOf(eur.id)).actual).toBe(7777);
  });

  it('a team goal counts its members only, and lists who contributed', async () => {
    const g = await goal({ metric: 'deals_won', scope: { type: 'team', teamId }, target: 3 });
    const detail = await svc.getById({ organizationId: orgId, id: g.id });
    expect(detail.progress.actual).toBe(3); // alice's 3 won deals in March (bob is not on the team)
    expect(detail.contributors).toEqual([{ userId: alice, name: 'alice', value: 3 }]);
    const orgWide = await svc.getById({ organizationId: orgId, id: (await goal({ metric: 'deals_won' })).id });
    expect(orgWide.contributors.map((c) => [c.name, c.value])).toEqual([
      ['alice', 3],
      ['bob', 1],
    ]);

    await db.delete(s.teamMembers).where(eq(s.teamMembers.teamId, teamId));
    expect((await progressOf(g.id)).actual).toBe(0); // an empty team has produced nothing
    await db.insert(s.teamMembers).values({ teamId, userId: alice, organizationId: orgId });
  });

  it('counts orders, converted leads, accepted quotes and resolved tickets', async () => {
    await db.insert(s.orders).values([
      { organizationId: orgId, orderNumber: counter++, currency: 'USD', totalMinor: 3000, createdBy: alice, createdAt: inMarch },
      { organizationId: orgId, orderNumber: counter++, currency: 'USD', totalMinor: 2000, createdBy: alice, createdAt: inMarch },
      { organizationId: orgId, orderNumber: counter++, currency: 'USD', totalMinor: 9000, createdBy: alice, createdAt: inMarch, status: 'cancelled' },
    ]);
    await db.insert(s.leads).values([
      { organizationId: orgId, firstName: 'a', assignedTo: alice, status: 'converted', convertedAt: inMarch },
      { organizationId: orgId, firstName: 'b', assignedTo: alice, status: 'converted', convertedAt: new Date('2026-01-10T00:00:00Z') },
      { organizationId: orgId, firstName: 'c', assignedTo: alice },
    ]);
    await db.insert(s.quotes).values([
      { organizationId: orgId, quoteNumber: counter++, currency: 'USD', status: 'accepted', respondedAt: inMarch, createdBy: alice },
      { organizationId: orgId, quoteNumber: counter++, currency: 'USD', status: 'rejected', respondedAt: inMarch, createdBy: alice },
    ]);
    await db.insert(s.supportTickets).values([
      { organizationId: orgId, ticketNumber: counter++, subject: 't', slaDueAt: inMarch, status: 'resolved', resolvedAt: inMarch, assignedTo: alice },
      { organizationId: orgId, ticketNumber: counter++, subject: 't', slaDueAt: inMarch, status: 'open', assignedTo: alice },
    ]);
    const forAlice = (metric: string, extra: Record<string, unknown> = {}) =>
      goal({ metric, scope: { type: 'user', userId: alice }, target: 1, ...extra }).then((g) => progressOf(g.id));
    expect((await forAlice('orders_value', { currency: 'USD' })).actual).toBe(5000); // the cancelled order is not counted
    expect((await forAlice('leads_converted')).actual).toBe(1);
    expect((await forAlice('quotes_accepted')).actual).toBe(1);
    expect((await forAlice('tickets_resolved')).actual).toBe(1);
  });

  it('measures whole days on the organization clock, not UTC', async () => {
    await db.update(s.organizations).set({ timezone: 'Asia/Kolkata' }).where(eq(s.organizations.id, orgId)); // UTC+5:30
    await deal(bob, { updatedAt: new Date('2026-02-28T19:00:00Z') }); // 00:30 on 1 March in Kolkata: inside March (UTC says February)
    await deal(bob, { updatedAt: new Date('2026-03-31T17:00:00Z') }); // 22:30 on 31 March: inside
    await deal(bob, { updatedAt: new Date('2026-03-31T20:00:00Z') }); // 01:30 on 1 April: outside (UTC says March)
    const g = await goal({ metric: 'deals_won', scope: { type: 'user', userId: bob }, target: 1 });
    expect((await progressOf(g.id)).actual).toBe(1 + 2); // the earlier one plus the two that fall inside
    await db.update(s.organizations).set({ timezone: 'UTC' }).where(eq(s.organizations.id, orgId));
  });

  it('compares a running period with the straight-line pace', async () => {
    const current = await svc.create({
      organizationId: orgId,
      userId: alice,
      input: { name: 'now', metric: 'deals_won', scope: { type: 'organization' }, period: 'year', target: 1_000_000 } as never,
    });
    const progress = await progressOf(current.id);
    expect(progress.state).toBe('behind');
    expect(progress.expected).toBeGreaterThan(0);
    const upcoming = await goal({ startDate: '2999-01-01', endDate: '2999-12-31' });
    expect((await progressOf(upcoming.id)).state).toBe('upcoming');
  });

  it('lists current and past goals, edits only name and target, deletes, and isolates organizations', async () => {
    const mine = await goal({ name: 'to edit' });
    const past = await svc.list({ organizationId: orgId, query: { when: 'past' } as never });
    expect(past.some((g) => g.id === mine.id)).toBe(true);
    expect((await svc.list({ organizationId: orgId, query: { when: 'current' } as never })).some((g) => g.id === mine.id)).toBe(false);
    expect((await svc.list({ organizationId: orgId, query: { when: 'all', userId: alice } as never })).every((g) => g.userId === alice)).toBe(true);

    expect(await svc.update({ organizationId: orgId, id: mine.id, input: { target: 99, name: 'renamed' } })).toMatchObject({
      target: 99,
      name: 'renamed',
      metric: 'deals_won',
    });
    expect(await code(svc.getById({ organizationId: otherOrgId, id: mine.id }))).toBe('NOT_FOUND');
    expect(await code(svc.update({ organizationId: otherOrgId, id: mine.id, input: { target: 1 } }))).toBe('NOT_FOUND');
    expect(await code(svc.remove({ organizationId: otherOrgId, id: mine.id }))).toBe('NOT_FOUND');
    await svc.remove({ organizationId: orgId, id: mine.id });
    expect(await code(svc.getById({ organizationId: orgId, id: mine.id }))).toBe('NOT_FOUND');
  });

  it('ranks people on the leaderboard: active only, zero skipped, highest first', async () => {
    await deal(carol, { valueMinor: 99_999 }); // inactive: never listed
    await deal(alice);
    await deal(alice); // alice now clearly ahead of bob
    const board = await svc.leaderboard({ organizationId: orgId, query: { metric: 'deals_won', period: 'month', on: '2026-03-10', limit: 10 } as never });
    expect(board).toMatchObject({ startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(board.entries.map((e) => [e.rank, e.name])).toEqual([
      [1, 'alice'],
      [2, 'bob'],
    ]);
    expect(board.entries[0]!.value).toBeGreaterThan(board.entries[1]!.value);
    const money = await svc.leaderboard({
      organizationId: orgId,
      query: { metric: 'revenue_won', currency: 'USD', period: 'month', on: '2026-03-10', limit: 1 } as never,
    });
    expect(money.entries).toHaveLength(1);
    expect(money.entries[0]).toMatchObject({ rank: 1, name: 'alice' });
    expect(
      (await svc.leaderboard({ organizationId: otherOrgId, query: { metric: 'deals_won', period: 'month', on: '2026-03-10', limit: 10 } as never })).entries,
    ).toEqual([]);
  });
});
