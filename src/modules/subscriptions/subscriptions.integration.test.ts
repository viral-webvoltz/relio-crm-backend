// Subscriptions integration test: billing, double-billing races, failures, pause/resume and limits, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('subscriptions (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let svc: typeof import('./subscriptions.service.js').subscriptionsService;
  let dates: typeof import('./subscriptions.schedule.js');
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let contactId: string;
  let widget: string; // price 1000, stock tracked
  let service: string; // price 5000, not stock tracked

  const base = () => ({ organizationId: orgId, userId });
  const today = () => dates.localDate(new Date(), 'UTC');
  const make = (extra: Record<string, unknown> = {}) =>
    svc.create({
      ...base(),
      input: {
        name: 'Hosting',
        contactId,
        items: [{ productId: service, quantity: 1 }],
        taxRateBps: 1000,
        intervalUnit: 'month',
        intervalCount: 1,
        startOn: today(),
        dueDays: 14,
        autoSend: false,
        ...extra,
      } as never,
    });
  const reload = async (id: string) => (await db.select().from(s.subscriptions).where(eq(s.subscriptions.id, id)))[0]!;
  const runsOf = (id: string) => db.select().from(s.subscriptionRuns).where(eq(s.subscriptionRuns.subscriptionId, id));
  const set = (id: string, values: Partial<typeof s.subscriptions.$inferInsert>) => db.update(s.subscriptions).set(values).where(eq(s.subscriptions.id, id));
  const stockOf = async (id: string) => (await db.select().from(s.products).where(eq(s.products.id, id)))[0]!.stockQuantity;
  const code = async (work: Promise<unknown>) =>
    (
      (await work.then(
        () => null,
        (err: unknown) => err,
      )) as { code?: string } | null
    )?.code;
  // Only look at this subscription: runDue scans the whole table.
  const bill = async (id: string) => {
    await svc.runDue();
    return reload(id);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
    ({ subscriptionsService: svc } = await import('./subscriptions.service.js'));
    dates = await import('./subscriptions.schedule.js');

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `sub-${tag}`, slug: `sub-${tag}` },
        { name: `sub2-${tag}`, slug: `sub2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    userId = (
      await db
        .insert(s.users)
        .values({ organizationId: orgId, email: `sub-${tag}@example.test`, fullName: 'Biller', passwordHash: 'x' })
        .returning()
    )[0]!.id;
    contactId = (
      await db
        .insert(s.contacts)
        .values({ organizationId: orgId, firstName: 'Cora', lastName: 'Client', email: `cora-${tag}@example.test` })
        .returning()
    )[0]!.id;
    const prods = await db
      .insert(s.products)
      .values([
        { organizationId: orgId, name: 'Widget', priceMinor: 1000, currency: 'USD', stockQuantity: 20, trackInventory: true },
        { organizationId: orgId, name: 'Hosting plan', priceMinor: 5000, currency: 'USD', trackInventory: false },
      ])
      .returning();
    widget = prods[0]!.id;
    service = prods[1]!.id;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('creates a subscription with a fixed price, a per-run total and the upcoming dates', async () => {
    const sub = await make({
      items: [{ productId: widget, quantity: 2, unitPriceMinor: 900 }],
      startOn: dates.addDays(today(), 3),
      intervalUnit: 'week',
      intervalCount: 2,
    });
    expect(sub).toMatchObject({ status: 'active', customerName: 'Cora Client', currency: 'USD', nextRunOn: dates.addDays(today(), 3), runCount: 0, cycle: 0 });
    const detail = await svc.getById({ organizationId: orgId, id: sub.id });
    expect(detail.items.map((i) => [i.quantity, i.unitPriceMinor])).toEqual([[2, 900]]);
    expect(detail.perRun).toMatchObject({ subtotalMinor: 1800, taxMinor: 180, totalMinor: 1980 });
    expect(detail.upcoming).toEqual([0, 1, 2, 3, 4].map((k) => dates.addDays(today(), 3 + 14 * k)));
  });

  it('rejects a start in the past, a bad product, an empty schedule and an oversized discount', async () => {
    expect(await code(make({ startOn: dates.addDays(today(), -1) }))).toBe('START_IN_PAST');
    expect(await code(make({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] }))).toBe('INVALID_PRODUCT');
    expect(await code(make({ discount: { type: 'fixed', value: 999_999 } }))).toBe('DISCOUNT_TOO_LARGE');
    expect(await code(make({ startOn: dates.addDays(today(), 5), endOn: dates.addDays(today(), 2) }))).toBe('EMPTY_SCHEDULE');
  });

  it('keeps other organizations out', async () => {
    const sub = await make({ startOn: dates.addDays(today(), 9) });
    expect(await code(svc.getById({ organizationId: otherOrgId, id: sub.id }))).toBe('NOT_FOUND');
    expect(await code(svc.pause({ organizationId: otherOrgId, id: sub.id }))).toBe('NOT_FOUND');
  });

  it('bills a due date: order and invoice at the agreed price, stock taken, schedule advanced', async () => {
    const sub = await make({ items: [{ productId: widget, quantity: 3, unitPriceMinor: 800 }], dueDays: 10 });
    const before = await stockOf(widget);
    const billed = await bill(sub.id);

    expect(billed).toMatchObject({ runCount: 1, cycle: 1, failureCount: 0, status: 'active', nextRunOn: dates.occurrence(today(), 'month', 1, 1) });
    const [run] = await runsOf(sub.id);
    expect(run).toMatchObject({ status: 'invoiced', scheduledFor: today() });
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, run!.invoiceId!));
    expect(invoice).toMatchObject({ totalMinor: 2640, status: 'unpaid', dueDate: dates.addDays(today(), 10) }); // 3 x 800 = 2400, +10% tax
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, run!.orderId!));
    expect(order).toMatchObject({ totalMinor: 2640, contactId });
    expect(await stockOf(widget)).toBe(before - 3);

    await svc.runDue(); // nothing is due any more
    expect(await runsOf(sub.id)).toHaveLength(1);
  });

  it('never bills the same date twice, even when two instances scan at once', async () => {
    const sub = await make();
    await Promise.all([svc.runDue(), svc.runDue(), svc.runDue()]);
    expect((await runsOf(sub.id)).filter((r) => r.status === 'invoiced')).toHaveLength(1);
    expect((await reload(sub.id)).runCount).toBe(1);
  });

  it('bills one overdue date per pass when the scheduler was down', async () => {
    const sub = await make();
    await set(sub.id, { nextRunOn: dates.addDays(today(), -3) });
    const billed = await bill(sub.id);
    expect(billed.runCount).toBe(1);
    expect((await runsOf(sub.id))[0]!.scheduledFor).toBe(dates.addDays(today(), -3));
  });

  it('finishes at the run limit and when the end date is cut below what has been billed', async () => {
    const limited = await make({ maxRuns: 1 });
    expect(await bill(limited.id)).toMatchObject({ status: 'completed', nextRunOn: null, runCount: 1 });
    expect(await code(svc.pause({ organizationId: orgId, id: limited.id }))).toBe('SUBSCRIPTION_LOCKED');

    const open = await make({ startOn: dates.addDays(today(), 4) });
    const cut = await svc.update({ organizationId: orgId, id: open.id, input: { endOn: dates.addDays(today(), 1) } });
    expect(cut).toMatchObject({ status: 'completed', nextRunOn: null });
  });

  it('changes the terms of future invoices only', async () => {
    const sub = await make();
    await bill(sub.id);
    await svc.update({ organizationId: orgId, id: sub.id, input: { items: [{ productId: service, quantity: 2 }], taxRateBps: 0 } });
    await set(sub.id, { nextRunOn: dates.addDays(today(), -1) }); // a different date than the one already billed
    await bill(sub.id);
    const totals = (await runsOf(sub.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const invoices = await Promise.all(totals.map(async (r) => (await db.select().from(s.invoices).where(eq(s.invoices.id, r.invoiceId!)))[0]!.totalMinor));
    expect(invoices).toEqual([5500, 10_000]); // the first invoice kept its old terms
  });

  it('records a failure, retries only after a while, and pauses after three in a row with a notification', async () => {
    const sub = await make({ items: [{ productId: widget, quantity: 500 }] }); // far more than the stock
    const ordersBefore = (await db.select().from(s.orders).where(eq(s.orders.organizationId, orgId))).length;

    expect(await bill(sub.id)).toMatchObject({ failureCount: 1, status: 'active' });
    expect((await reload(sub.id)).lastError).toMatch(/in stock/);
    await svc.runDue(); // too soon to retry
    expect((await reload(sub.id)).failureCount).toBe(1);

    for (const expected of [2, 3]) {
      await set(sub.id, { lastAttemptAt: new Date(Date.now() - 7 * 3_600_000) });
      await bill(sub.id);
      expect((await reload(sub.id)).failureCount).toBe(expected);
    }
    expect(await reload(sub.id)).toMatchObject({ status: 'paused', runCount: 0 });
    expect((await runsOf(sub.id)).filter((r) => r.status === 'failed')).toHaveLength(3);
    expect((await db.select().from(s.orders).where(eq(s.orders.organizationId, orgId))).length).toBe(ordersBefore); // nothing half-created
    const notes = await db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.userId, userId), eq(s.notifications.type, 'workflow')));
    expect(notes.some((n) => n.title === 'Subscription "Hosting" was paused')).toBe(true);
  });

  it('resumes without billing the paused time', async () => {
    const sub = await make({ startOn: dates.addDays(today(), -0), intervalUnit: 'week' });
    await svc.pause({ organizationId: orgId, id: sub.id });
    await svc.runDue();
    expect((await runsOf(sub.id)).length).toBe(0); // paused: not billed even though it is due

    // pretend it was paused for three weeks
    await set(sub.id, { startOn: dates.addDays(today(), -21), nextRunOn: dates.addDays(today(), -21), cycle: 0 });
    const resumed = await svc.resume({ organizationId: orgId, id: sub.id });
    expect(resumed).toMatchObject({ status: 'active', cycle: 3, runCount: 0, failureCount: 0 });
    expect(resumed.nextRunOn).toBe(today()); // the date that falls today is still billed
    expect(await code(svc.resume({ organizationId: orgId, id: sub.id }))).toBe('SUBSCRIPTION_LOCKED');
  });

  it('can be billed ahead of its date by hand, and refuses when it is not active', async () => {
    const sub = await make({ startOn: dates.addDays(today(), 10) });
    const { invoice } = await svc.runNow({ ...base(), id: sub.id });
    expect(invoice.totalMinor).toBe(5500);
    expect((await reload(sub.id)).runCount).toBe(1);
    await svc.pause({ organizationId: orgId, id: sub.id });
    expect(await code(svc.runNow({ ...base(), id: sub.id }))).toBe('SUBSCRIPTION_NOT_ACTIVE');
  });

  it('removes one that never billed, and cancels one that did', async () => {
    const fresh = await make({ startOn: dates.addDays(today(), 20) });
    await svc.remove({ organizationId: orgId, id: fresh.id });
    expect(await code(svc.getById({ organizationId: orgId, id: fresh.id }))).toBe('NOT_FOUND');

    const used = await make();
    await bill(used.id);
    expect(await code(svc.remove({ organizationId: orgId, id: used.id }))).toBe('SUBSCRIPTION_HAS_INVOICES');
    expect(await svc.cancel({ organizationId: orgId, id: used.id })).toMatchObject({ status: 'cancelled', nextRunOn: null });
    expect(await code(svc.cancel({ organizationId: orgId, id: used.id }))).toBe('SUBSCRIPTION_LOCKED');
  });

  it('bills on the date in the organization timezone, not in UTC', async () => {
    await db.update(s.organizations).set({ timezone: 'Pacific/Kiritimati' }).where(eq(s.organizations.id, orgId)); // UTC+14: a day ahead
    const tomorrowUtc = dates.addDays(today(), 1);
    const sub = await svc.create({
      ...base(),
      input: {
        name: 'Kiribati',
        contactId,
        items: [{ productId: service, quantity: 1 }],
        taxRateBps: 0,
        intervalUnit: 'month',
        intervalCount: 1,
        startOn: tomorrowUtc,
        dueDays: 14,
        autoSend: false,
      } as never,
    });
    const billed = await bill(sub.id);
    // it is already tomorrow there, so the date has come
    expect(billed.runCount).toBe(dates.localDate(new Date(), 'Pacific/Kiritimati') >= tomorrowUtc ? 1 : 0);
    await db.update(s.organizations).set({ timezone: 'UTC' }).where(eq(s.organizations.id, orgId));
  });
});
