// Portal isolation integration test: customer A must never see or touch customer B's (same org) or customer C's (other org) data.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   PowerShell:  $env:TEST_DATABASE_URL = 'postgres://user:pass@localhost:5432/crm_test'; npm run test:integration
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It only inserts uniquely-named organizations and deletes them (cascade) afterwards,
// but it still writes. TEST_DATABASE_URL is copied into DATABASE_URL before any app module is imported.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('portal isolation (database)', () => {
  type Ctx = Awaited<ReturnType<typeof seed>>;
  let ctx: Ctx;
  let cleanup: () => Promise<void>;
  let portalService: typeof import('./portal.service.js').portalService;
  let supportPortalService: typeof import('@/modules/support/support.portal.service.js').supportPortalService;
  const query = { page: 1, limit: 50 } as never;

  async function seed() {
    process.env.DATABASE_URL = testUrl;
    const { db, pool } = await import('@/config/database.js');
    const s = await import('@/database/schema/index.js');
    const tag = crypto.randomUUID().slice(0, 8);

    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `iso1-${tag}`, slug: `iso1-${tag}` },
        { name: `iso2-${tag}`, slug: `iso2-${tag}` },
      ])
      .returning();
    const [org1, org2] = orgs;
    if (!org1 || !org2) throw new Error('seed failed');

    const people = await db
      .insert(s.contacts)
      .values([
        { organizationId: org1.id, firstName: 'Alice' },
        { organizationId: org1.id, firstName: 'Bob' },
        { organizationId: org2.id, firstName: 'Carol' },
      ])
      .returning();
    const [a, b, c] = people;
    if (!a || !b || !c) throw new Error('seed failed');

    const scope = (contact: typeof a, organizationId: string) => ({
      accountId: crypto.randomUUID(),
      organizationId,
      contactId: contact.id,
      email: `${contact.firstName}@example.test`,
      firstName: contact.firstName,
      lastName: null,
      phone: null,
      organizationName: 'x',
      mustChangePassword: false,
    });

    const mk = async (organizationId: string, contactId: string, n: number) => {
      const [order] = await db
        .insert(s.orders)
        .values({ organizationId, contactId, orderNumber: n, currency: 'USD', totalMinor: 1000 * n, notes: 'internal' })
        .returning();
      if (!order) throw new Error('seed failed');
      const [invoice] = await db
        .insert(s.invoices)
        .values({ organizationId, orderId: order.id, invoiceNumber: n, currency: 'USD', totalMinor: 1000 * n, dueDate: '2030-01-01', notes: 'internal' })
        .returning();
      const [ticket] = await db
        .insert(s.supportTickets)
        .values({ organizationId, contactId, ticketNumber: n, subject: `t${n}`, slaDueAt: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!invoice || !ticket) throw new Error('seed failed');
      await db.insert(s.ticketMessages).values([
        { organizationId, ticketId: ticket.id, authorType: 'staff', body: 'public', isInternal: false },
        { organizationId, ticketId: ticket.id, authorType: 'staff', body: 'internal note', isInternal: true },
      ]);
      return { order, invoice, ticket };
    };

    const ownA = await mk(org1.id, a.id, 1);
    const ownB = await mk(org1.id, b.id, 2);
    const ownC = await mk(org2.id, c.id, 1); // same numbers as A on purpose, in another organization

    const orgIds = [org1.id, org2.id];
    cleanup = async () => {
      // invoices -> orders is RESTRICT, so invoices go first; the rest cascades from the organizations.
      const { eq } = await import('drizzle-orm');
      for (const id of orgIds) await db.delete(s.invoices).where(eq(s.invoices.organizationId, id));
      for (const id of orgIds) await db.delete(s.organizations).where(eq(s.organizations.id, id));
      await pool.end();
    };
    return { A: scope(a, org1.id), data: { A: ownA, B: ownB, C: ownC } };
  }

  beforeAll(async () => {
    ctx = await seed();
    ({ portalService } = await import('./portal.service.js'));
    ({ supportPortalService } = await import('@/modules/support/support.portal.service.js'));
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("lists only A's own orders, invoices and tickets", async () => {
    const orders = await portalService.listOrders(ctx.A, query);
    expect(orders.rows.map((r) => r.id)).toEqual([ctx.data.A.order.id]);
    expect(orders.total).toBe(1);

    const invoices = await portalService.listInvoices(ctx.A, query);
    expect(invoices.rows.map((r) => r.id)).toEqual([ctx.data.A.invoice.id]);

    const tickets = await supportPortalService.listTickets(ctx.A, query);
    expect(tickets.rows.map((r) => r.id)).toEqual([ctx.data.A.ticket.id]);
    expect(tickets.total).toBe(1);
  });

  it('A can read their own records, without internal fields', async () => {
    const order = await portalService.getOrder(ctx.A, ctx.data.A.order.id);
    expect(order).not.toHaveProperty('notes');
    const invoice = await portalService.getInvoice(ctx.A, ctx.data.A.invoice.id);
    expect(invoice).not.toHaveProperty('notes');
    const ticket = await supportPortalService.getTicket(ctx.A, ctx.data.A.ticket.id);
    expect(ticket.messages.map((m) => m.body)).toEqual(['public']);
  });

  it.each(['B', 'C'] as const)("by-id of %s's rows is 404 (not 403)", async (who) => {
    const d = ctx.data[who];
    await expect(portalService.getOrder(ctx.A, d.order.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(portalService.getInvoice(ctx.A, d.invoice.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(supportPortalService.getTicket(ctx.A, d.ticket.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(['B', 'C'] as const)("replying on %s's ticket fails with 404 and writes nothing", async (who) => {
    const { ticket } = ctx.data[who];
    await expect(supportPortalService.addReply({ customer: ctx.A, id: ticket.id, body: 'hi' })).rejects.toMatchObject({ statusCode: 404 });
    const { db } = await import('@/config/database.js');
    const s = await import('@/database/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const msgs = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.ticketId, ticket.id));
    expect(msgs.filter((m) => m.authorType === 'customer')).toHaveLength(0);
  });

  it("a customer in the same org id but wrong organization scope cannot reach A's rows", async () => {
    const forged = { ...ctx.A, organizationId: ctx.data.C.order.organizationId };
    await expect(portalService.getOrder(forged, ctx.data.A.order.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(supportPortalService.getTicket(forged, ctx.data.A.ticket.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
