// Quotes integration test: totals, the customer link, accept/reject, and conversion to an order and an invoice, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('quotes (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let quotesService: typeof import('./quotes.service.js').quotesService;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let contactId: string;
  let widget: { id: string; priceMinor: number };
  let gadget: { id: string };

  const stockOf = async (productId: string) => (await db.select().from(s.products).where(eq(s.products.id, productId)))[0]!.stockQuantity;
  const tokenOf = (link: string) => link.split('/').pop()!;
  const base = () => ({ organizationId: orgId, userId });
  const make = (extra: Record<string, unknown> = {}) =>
    quotesService.create({
      ...base(),
      input: { contactId, items: [{ productId: widget.id, quantity: 3 }], taxRateBps: 1000, ...extra } as never,
    });
  const sendAndAccept = async (quoteId: string) => {
    const { link } = await quotesService.send({ ...base(), id: quoteId, input: {} });
    await quotesService.accept(tokenOf(link), { name: 'Alex Buyer', note: null });
    return tokenOf(link);
  };
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
    ({ quotesService } = await import('./quotes.service.js'));

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `q-${tag}`, slug: `q-${tag}` },
        { name: `q2-${tag}`, slug: `q2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    const [user] = await db
      .insert(s.users)
      .values({ organizationId: orgId, email: `q-${tag}@example.test`, fullName: 'Quote Tester', passwordHash: 'x' })
      .returning();
    userId = user!.id;
    const [contact] = await db
      .insert(s.contacts)
      .values({ organizationId: orgId, firstName: 'Alex', lastName: 'Buyer', email: `buyer-${tag}@example.test` })
      .returning();
    contactId = contact!.id;
    const prods = await db
      .insert(s.products)
      .values([
        { organizationId: orgId, name: 'Widget', sku: 'W-1', priceMinor: 2000, currency: 'USD', stockQuantity: 10 },
        { organizationId: orgId, name: 'Gadget', sku: 'G-1', priceMinor: 500, currency: 'USD', stockQuantity: 10 },
      ])
      .returning();
    widget = prods[0]!;
    gadget = prods[1]!;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('prices the lines, applies discount then tax, and numbers quotes without gaps', async () => {
    const a = await make({ discount: { type: 'fixed', value: 1000 } });
    const b = await make({
      items: [
        { productId: widget.id, quantity: 1, unitPriceMinor: 1500 },
        { productId: gadget.id, quantity: 2 },
      ],
    });
    // 3 x 2000 = 6000, minus 1000 = 5000, plus 10% tax = 5500
    expect(a).toMatchObject({
      status: 'draft',
      subtotalMinor: 6000,
      discountMinor: 1000,
      taxMinor: 500,
      totalMinor: 5500,
      customerName: 'Alex Buyer',
      currency: 'USD',
    });
    expect(b.quoteNumber).toBe(a.quoteNumber + 1);
    // the offered price (1500) wins over the catalogue price; 1500 + 2 x 500 = 2500, plus 10% = 2750
    expect(b.totalMinor).toBe(2750);
    expect(a).not.toHaveProperty('publicTokenHash');
  });

  it('rejects a bad product, a deal from nowhere and an oversized discount', async () => {
    expect(await code(make({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] }))).toBe('INVALID_PRODUCT');
    expect(await code(make({ dealId: crypto.randomUUID() }))).toBe('INVALID_DEAL');
    expect(await code(make({ discount: { type: 'fixed', value: 999_999 } }))).toBe('DISCOUNT_TOO_LARGE');
  });

  it('keeps other organizations out', async () => {
    const q = await make();
    expect(await code(quotesService.getById({ organizationId: otherOrgId, id: q.id }))).toBe('NOT_FOUND');
    expect(await code(quotesService.send({ organizationId: otherOrgId, userId, id: q.id, input: {} }))).toBe('NOT_FOUND');
  });

  it('sends a quote: only the hash of the link is stored, and the page shows no internals', async () => {
    const q = await make();
    const { link, quote } = await quotesService.send({ ...base(), id: q.id, input: {} });
    expect(quote.status).toBe('sent');
    expect(quote.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaulted
    const [row] = await db.select().from(s.quotes).where(eq(s.quotes.id, q.id));
    expect(row?.publicTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(link).not.toContain(row!.publicTokenHash!);

    const page = await quotesService.publicView(tokenOf(link));
    expect(page).toMatchObject({ quoteNumber: q.quoteNumber, status: 'sent', canRespond: true, totalMinor: q.totalMinor });
    expect(JSON.stringify(page)).not.toMatch(/organizationId|createdBy|publicTokenHash|"id"/);
    expect(await code(quotesService.publicView('0'.repeat(64)))).toBe('NOT_FOUND');
  });

  it('refuses to mail a quote to someone outside the organization', async () => {
    const q = await make();
    expect(await code(quotesService.send({ ...base(), id: q.id, input: { to: 'stranger@elsewhere.test' } }))).toBe('RECIPIENT_NOT_ALLOWED');
  });

  it('editing a sent quote takes it back to draft and kills the old link', async () => {
    const q = await make();
    const { link } = await quotesService.send({ ...base(), id: q.id, input: {} });
    const edited = await quotesService.update({ organizationId: orgId, id: q.id, input: { items: [{ productId: widget.id, quantity: 5 }] } });
    expect(edited).toMatchObject({ status: 'draft', subtotalMinor: 10_000, totalMinor: 11_000 });
    expect(await code(quotesService.publicView(tokenOf(link)))).toBe('NOT_FOUND');
    expect(await code(quotesService.accept(tokenOf(link), { name: 'Late', note: null }))).toBe('NOT_FOUND');
  });

  it('accepts once: a second answer is refused, and the creator is notified', async () => {
    const q = await make();
    const { link } = await quotesService.send({ ...base(), id: q.id, input: {} });
    const token = tokenOf(link);
    const answered = await quotesService.accept(token, { name: 'Alex Buyer', note: 'Go ahead' });
    expect(answered).toMatchObject({ status: 'accepted', canRespond: false, respondedByName: 'Alex Buyer' });
    expect(await code(quotesService.accept(token, { name: 'Again', note: null }))).toBe('ALREADY_RESPONDED');
    expect(await code(quotesService.reject(token, { note: null }))).toBe('ALREADY_RESPONDED');

    await new Promise((resolve) => setTimeout(resolve, 100)); // the notification is written in the background
    const notes = await db.select().from(s.notifications).where(eq(s.notifications.relatedId, q.id));
    expect(notes.map((n) => n.title)).toEqual([`Quote #${q.quoteNumber} accepted by Alex Buyer`]);
  });

  it('simultaneous accept and reject: exactly one wins', async () => {
    const q = await make();
    const token = tokenOf((await quotesService.send({ ...base(), id: q.id, input: {} })).link);
    const results = await Promise.allSettled([quotesService.accept(token, { name: 'A', note: null }), quotesService.reject(token, { note: null })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('declines, and an expired quote can no longer be answered', async () => {
    const declined = await make();
    const t1 = tokenOf((await quotesService.send({ ...base(), id: declined.id, input: {} })).link);
    expect(await quotesService.reject(t1, { note: 'Too pricey' })).toMatchObject({ status: 'rejected', canRespond: false });

    const old = await make();
    const t2 = tokenOf((await quotesService.send({ ...base(), id: old.id, input: {} })).link);
    await db.update(s.quotes).set({ validUntil: '2020-01-01' }).where(eq(s.quotes.id, old.id));
    expect(await quotesService.publicView(t2)).toMatchObject({ status: 'expired', canRespond: false });
    expect(await code(quotesService.accept(t2, { name: 'Late', note: null }))).toBe('QUOTE_EXPIRED');
    expect((await quotesService.getById({ organizationId: orgId, id: old.id })).status).toBe('expired');
    expect(await code(quotesService.send({ ...base(), id: old.id, input: {} }))).toBe('QUOTE_EXPIRED');
  });

  it('lists with the derived expired status', async () => {
    const { rows } = await quotesService.list({ organizationId: orgId, query: { page: 1, limit: 100, status: 'expired' } as never });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'expired')).toBe(true);
  });

  it('converts an accepted quote into an order at the quoted prices, once', async () => {
    const q = await make({ items: [{ productId: widget.id, quantity: 2, unitPriceMinor: 1500 }] }); // 3000 + 10% = 3300
    expect(await code(quotesService.convert({ ...base(), id: q.id, input: { target: 'order' } }))).toBe('NOT_ACCEPTED');
    await sendAndAccept(q.id);

    const before = await stockOf(widget.id);
    const { order, invoice, quote } = await quotesService.convert({ ...base(), id: q.id, input: { target: 'order' } });
    expect(invoice).toBeNull();
    expect(order).toMatchObject({ totalMinor: 3300, subtotalMinor: 3000, taxMinor: 300, contactId, status: 'pending' });
    const items = await db.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
    expect(items.map((i) => [i.quantity, i.unitPriceMinor])).toEqual([[2, 1500]]);
    const after = await stockOf(widget.id);
    expect(after).toBe(before - 2);
    expect(quote.convertedOrderId).toBe(order.id);
    expect((await quotesService.getById({ organizationId: orgId, id: q.id })).orderNumber).toBe(order.orderNumber);

    expect(await code(quotesService.convert({ ...base(), id: q.id, input: { target: 'order' } }))).toBe('ALREADY_CONVERTED');
    expect(await code(quotesService.update({ organizationId: orgId, id: q.id, input: { notes: 'x' } }))).toBe('QUOTE_LOCKED');
    expect(await code(quotesService.remove({ organizationId: orgId, id: q.id }))).toBe('QUOTE_LOCKED');
  });

  it('converts straight to an invoice with the quoted total', async () => {
    const q = await make({ items: [{ productId: gadget.id, quantity: 4 }], taxRateBps: 0 });
    await sendAndAccept(q.id);
    const { order, invoice } = await quotesService.convert({ ...base(), id: q.id, input: { target: 'invoice', dueDate: '2030-01-31' } });
    expect(invoice).toMatchObject({ orderId: order.id, totalMinor: 2000, dueDate: '2030-01-31', status: 'unpaid' });
  });

  it('rolls back everything when the order cannot be placed (no stock), leaving the quote accepted', async () => {
    const q = await make({ items: [{ productId: gadget.id, quantity: 8 }] });
    await sendAndAccept(q.id);
    await db.update(s.products).set({ stockQuantity: 1 }).where(eq(s.products.id, gadget.id));
    const ordersBefore = (await db.select().from(s.orders).where(eq(s.orders.organizationId, orgId))).length;

    expect(await code(quotesService.convert({ ...base(), id: q.id, input: { target: 'invoice' } }))).toBe('INSUFFICIENT_STOCK');
    expect((await db.select().from(s.orders).where(eq(s.orders.organizationId, orgId))).length).toBe(ordersBefore);
    expect((await quotesService.getById({ organizationId: orgId, id: q.id })).status).toBe('accepted');

    await db.update(s.products).set({ stockQuantity: 20 }).where(eq(s.products.id, gadget.id));
    expect((await quotesService.convert({ ...base(), id: q.id, input: { target: 'order' } })).order.totalMinor).toBe(4400);
  });

  it('deletes only drafts and rejected quotes', async () => {
    const draft = await make();
    await quotesService.remove({ organizationId: orgId, id: draft.id });
    expect(await code(quotesService.getById({ organizationId: orgId, id: draft.id }))).toBe('NOT_FOUND');

    const sent = await make();
    await quotesService.send({ ...base(), id: sent.id, input: {} });
    expect(await code(quotesService.remove({ organizationId: orgId, id: sent.id }))).toBe('QUOTE_LOCKED');
  });
});
