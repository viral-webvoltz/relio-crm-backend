// Assignment integration test: teams, rule order and conditions, round robin, least loaded and the lead/ticket hooks, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('assignment (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let svc: typeof import('./assignment.service.js').assignmentService;
  let leadsService: typeof import('@/modules/leads/leads.service.js').leadsService;
  let supportService: typeof import('@/modules/support/support.service.js').supportService;
  let orgId: string;
  let otherOrgId: string;
  let people: string[]; // four active users, then one inactive
  let inactive: string;

  const lead = (extra: Record<string, unknown> = {}) =>
    leadsService.create({
      organizationId: orgId,
      canAssign: true,
      input: { firstName: 'L', source: 'website', status: 'new', priority: 'medium', score: 0, customFields: {}, ...extra } as never,
    });
  const ticket = (extra: Record<string, unknown> = {}) =>
    supportService.createTicket({ organizationId: orgId, userId: people[0]!, input: { subject: 'Help', body: 'x', priority: 'medium', ...extra } as never });
  const team = async (name: string, userIds: string[]) => {
    const t = await svc.createTeam({ organizationId: orgId, input: { name } as never });
    await svc.setMembers({ organizationId: orgId, id: t.id, userIds });
    return t;
  };
  const rule = (extra: Record<string, unknown>) =>
    svc.createRule({
      organizationId: orgId,
      input: { resource: 'leads', name: 'r', isActive: true, conditions: { mode: 'all', rules: [] }, ...extra } as never,
    });
  const clearRules = () => db.delete(s.assignmentRules).where(eq(s.assignmentRules.organizationId, orgId));
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
    ({ assignmentService: svc } = await import('./assignment.service.js'));
    ({ leadsService } = await import('@/modules/leads/leads.service.js'));
    ({ supportService } = await import('@/modules/support/support.service.js'));

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `as-${tag}`, slug: `as-${tag}` },
        { name: `as2-${tag}`, slug: `as2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    const rows = await db
      .insert(s.users)
      .values(
        ['a', 'b', 'c', 'd', 'x'].map((n) => ({
          organizationId: orgId,
          email: `${n}-${tag}@example.test`,
          fullName: `User ${n}`,
          passwordHash: 'x',
          isActive: n !== 'x',
        })),
      )
      .returning();
    people = rows.map((r) => r.id);
    inactive = people[4]!;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('manages teams: unique names, active members only, isolation, and a team in use cannot be deleted', async () => {
    const t = await team('Sales EU', [people[0]!, people[1]!]);
    expect((await svc.getTeam(orgId, t.id)).members.map((m) => m.id).sort()).toEqual([people[0]!, people[1]!].sort());
    expect(await code(svc.createTeam({ organizationId: orgId, input: { name: 'sales eu' } as never }))).toBe('TEAM_EXISTS');
    expect(await code(svc.setMembers({ organizationId: orgId, id: t.id, userIds: [inactive] }))).toBe('INVALID_MEMBER');
    expect(await code(svc.setMembers({ organizationId: orgId, id: t.id, userIds: [crypto.randomUUID()] }))).toBe('INVALID_MEMBER');
    expect(await code(svc.getTeam(otherOrgId, t.id))).toBe('NOT_FOUND');
    expect((await svc.listTeams(orgId)).find((x) => x.id === t.id)?.memberCount).toBe(2);

    await rule({ target: { type: 'team', teamId: t.id, strategy: 'round_robin' } });
    expect(await code(svc.removeTeam({ organizationId: orgId, id: t.id }))).toBe('TEAM_IN_USE');
    await clearRules();
    await svc.removeTeam({ organizationId: orgId, id: t.id });
  });

  it('validates a rule target against the organization', async () => {
    expect(await code(rule({ target: { type: 'team', teamId: crypto.randomUUID(), strategy: 'round_robin' } }))).toBe('INVALID_TARGET');
    expect(await code(rule({ target: { type: 'user', userId: inactive } }))).toBe('INVALID_TARGET');
    const { createRuleSchema } = await import('./assignment.validation.js');
    const bad = {
      resource: 'leads',
      name: 'x',
      conditions: { mode: 'all', rules: [{ field: 'source', operator: 'equals' }] },
      target: { type: 'user', userId: people[0] },
    };
    expect(createRuleSchema.safeParse(bad).success).toBe(false); // equals needs a value
    expect(createRuleSchema.safeParse({ ...bad, conditions: { mode: 'all', rules: [{ field: 'source', operator: 'changed' }] } }).success).toBe(false);
  });

  it('round robin shares leads evenly, skipping inactive members', async () => {
    const t = await team(
      'Rotation',
      [people[0]!, people[1]!, people[2]!, inactive].filter((id) => id !== inactive),
    );
    await rule({ target: { type: 'team', teamId: t.id, strategy: 'round_robin' } });
    const got: string[] = [];
    for (let i = 0; i < 9; i++) got.push((await lead()).assignedTo!);
    const counts = got.reduce<Record<string, number>>((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {});
    expect(counts).toEqual({ [people[0]!]: 3, [people[1]!]: 3, [people[2]!]: 3 });
    expect(new Set(got.slice(0, 3)).size).toBe(3); // a full lap first
    await clearRules();
  });

  it('round robin holds under simultaneous creates: nobody is picked twice in a lap', async () => {
    const t = await team('Parallel', [people[0]!, people[1]!, people[2]!, people[3]!]);
    await rule({ target: { type: 'team', teamId: t.id, strategy: 'round_robin' } });
    const picks = await Promise.all(Array.from({ length: 4 }, () => svc.pick({ organizationId: orgId, resource: 'leads', values: {} })));
    expect(new Set(picks.map((p) => p!.userId)).size).toBe(4);
    await clearRules();
  });

  it('least loaded gives the next lead to whoever has the fewest open ones', async () => {
    const t = await team('Load', [people[0]!, people[1]!]);
    await rule({ target: { type: 'team', teamId: t.id, strategy: 'least_loaded' } });
    const rows = await db.select().from(s.leads).where(eq(s.leads.organizationId, orgId));
    // give person 0 two open leads and person 1 one open lead + one converted lead (which does not count)
    await db.insert(s.leads).values([
      { organizationId: orgId, firstName: 'o1', assignedTo: people[0]! },
      { organizationId: orgId, firstName: 'o2', assignedTo: people[0]! },
      { organizationId: orgId, firstName: 'o3', assignedTo: people[1]! },
      { organizationId: orgId, firstName: 'o4', assignedTo: people[1]!, status: 'converted' },
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect((await lead()).assignedTo).toBe(people[1]); // 1 open versus 2
    expect((await lead()).assignedTo).toBe([people[0]!, people[1]!].sort()[0]); // level again: the tie goes to the lowest id
    await clearRules();
  });

  it('the first matching rule by position wins, a catch-all comes last, and a later rule is the fallback for an empty team', async () => {
    const empty = await svc.createTeam({ organizationId: orgId, input: { name: 'Empty' } as never });
    const vip = await rule({
      name: 'vip',
      conditions: { mode: 'all', rules: [{ field: 'priority', operator: 'equals', value: 'high' }] },
      target: { type: 'user', userId: people[2]! },
    });
    const web = await rule({
      name: 'web',
      conditions: {
        mode: 'any',
        rules: [
          { field: 'source', operator: 'equals', value: 'website' },
          { field: 'score', operator: 'gte', value: '50' },
        ],
      },
      target: { type: 'user', userId: people[1]! },
    });
    const emptyRule = await rule({ name: 'empty team', target: { type: 'team', teamId: empty.id, strategy: 'round_robin' } });
    const catchAll = await rule({ name: 'everyone else', target: { type: 'user', userId: people[3]! } });

    expect((await lead({ priority: 'high', source: 'website' })).assignedTo).toBe(people[2]); // vip is first
    expect((await lead({ source: 'website' })).assignedTo).toBe(people[1]);
    expect((await lead({ source: 'other', score: 80 })).assignedTo).toBe(people[1]); // "any" mode, numeric compare
    expect((await lead({ source: 'other' })).assignedTo).toBe(people[3]); // the empty-team rule matched but had nobody, so it fell through

    await svc.reorder({ organizationId: orgId, resource: 'leads', ids: [catchAll.id, vip.id, web.id, emptyRule.id] });
    expect((await lead({ priority: 'high' })).assignedTo).toBe(people[3]); // the catch-all now comes first
    expect(await code(svc.reorder({ organizationId: orgId, resource: 'leads', ids: [vip.id] }))).toBe('INVALID_ORDER');

    await svc.updateRule({ organizationId: orgId, id: catchAll.id, input: { isActive: false } });
    expect((await lead({ source: 'other' })).assignedTo).toBeNull(); // nothing matches: stays unassigned
    await clearRules();
    await svc.removeTeam({ organizationId: orgId, id: empty.id });
  });

  it('never overrides a person chosen on purpose, and does not touch other organizations', async () => {
    await rule({ target: { type: 'user', userId: people[0]! } });
    expect((await lead({ assignedTo: people[3]! })).assignedTo).toBe(people[3]);
    expect((await lead({ assignedTo: null })).assignedTo).toBeNull(); // explicit "nobody" is respected
    expect(await svc.pick({ organizationId: otherOrgId, resource: 'leads', values: {} })).toBeNull();
    expect(await code(svc.updateRule({ organizationId: otherOrgId, id: (await svc.listRules({ organizationId: orgId }))[0]!.id, input: { name: 'x' } }))).toBe(
      'NOT_FOUND',
    );
    await clearRules();
  });

  it('routes new tickets by their own conditions and notifies the assignee', async () => {
    await rule({
      resource: 'tickets',
      name: 'urgent',
      conditions: { mode: 'all', rules: [{ field: 'priority', operator: 'equals', value: 'urgent' }] },
      target: { type: 'user', userId: people[2]! },
    });
    const t = await ticket({ priority: 'urgent' });
    expect(t.assignedTo).toBe(people[2]);
    const alerts = await db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.relatedId, t.id), eq(s.notifications.userId, people[2]!)));
    expect(alerts.length).toBeGreaterThan(0);
    expect((await ticket({ priority: 'low' })).assignedTo).toBeNull();
    await clearRules();
  });

  it('a lead routed by rule notifies its assignee', async () => {
    await rule({ target: { type: 'user', userId: people[1]! } });
    const l = await lead();
    const alerts = await db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.relatedId, l.id), eq(s.notifications.userId, people[1]!)));
    expect(alerts.map((a) => a.type)).toEqual(['lead_assigned']);
    await clearRules();
  });

  it('dry-runs a sample without moving the rotation, and assigns what was left unassigned', async () => {
    const t = await team('Sweep', [people[0]!, people[1]!]);
    await rule({ target: { type: 'team', teamId: t.id, strategy: 'round_robin' } });
    const before = await svc.pick({ organizationId: orgId, resource: 'leads', values: {}, dryRun: true });
    const again = await svc.pick({ organizationId: orgId, resource: 'leads', values: {}, dryRun: true });
    expect(again!.userId).toBe(before!.userId); // a dry run does not advance

    await clearRules();
    const idle = await Promise.all([lead(), lead(), lead()]);
    expect(idle.every((l) => l.assignedTo === null)).toBe(true);
    await rule({ target: { type: 'team', teamId: t.id, strategy: 'round_robin' } });
    const result = await svc.applyToUnassigned({ organizationId: orgId, resource: 'leads', limit: 500 });
    expect(result.assigned).toBeGreaterThanOrEqual(3);
    const now = await db.select().from(s.leads).where(eq(s.leads.organizationId, orgId));
    expect(now.filter((l) => idle.some((i) => i.id === l.id)).every((l) => l.assignedTo !== null)).toBe(true);
    await clearRules();
  });
});
