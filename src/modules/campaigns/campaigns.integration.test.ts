// Campaigns integration test: audience, launch into the outbox, tracking, unsubscribe and scheduling, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
// No mail is sent: the mailer is not started, rows only land in the email_outbox table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('campaigns (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let svc: typeof import('./campaigns.service.js').campaignsService;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let userEmail: string;
  let tagId: string;

  const html = '<p>Hi {{first_name}}</p><a href="https://shop.example.test/sale?a=1&amp;b=2">Sale</a> <a href="{{unsubscribe_link}}">Unsubscribe</a>';
  const text = 'Hi {{first_name}} {{unsubscribe_link}}';
  const base = () => ({ organizationId: orgId, userId });
  const make = (extra: Record<string, unknown> = {}) =>
    svc.create({
      ...base(),
      input: { name: 'Spring sale', subject: 'Hello {{first_name}}', bodyHtml: html, bodyText: text, audience: { type: 'tag', tagId }, ...extra } as never,
    });
  const code = async (work: Promise<unknown>) =>
    (
      (await work.then(
        () => null,
        (err: unknown) => err,
      )) as { code?: string } | null
    )?.code;
  const outboxOf = (campaignId: string) =>
    db
      .select()
      .from(s.emailOutbox)
      .where(and(eq(s.emailOutbox.relatedId, campaignId), eq(s.emailOutbox.kind, 'campaign')));
  const recipientsOf = (campaignId: string) => db.select().from(s.campaignRecipients).where(eq(s.campaignRecipients.campaignId, campaignId));
  const tokenFor = async (campaignId: string, email: string) => (await recipientsOf(campaignId)).find((r) => r.email === email)!.token;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.SMTP_URL = 'smtp://localhost:2525'; // only so the feature is switched on; nothing connects
    process.env.MAIL_FROM = 'Shop <shop@example.test>';
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
    ({ campaignsService: svc } = await import('./campaigns.service.js'));

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `c-${tag}`, slug: `c-${tag}` },
        { name: `c2-${tag}`, slug: `c2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    userEmail = `staff-${tag}@example.test`;
    userId = (await db.insert(s.users).values({ organizationId: orgId, email: userEmail, fullName: 'Campaign Tester', passwordHash: 'x' }).returning())[0]!.id;
    tagId = (await db.insert(s.tags).values({ organizationId: orgId, name: 'vip', color: '#fff' }).returning())[0]!.id;

    const people = await db
      .insert(s.contacts)
      .values([
        { organizationId: orgId, firstName: 'Ann', lastName: 'A', email: 'ann@x.test' },
        { organizationId: orgId, firstName: 'Bob', email: 'bob@x.test' }, // unsubscribed earlier
        { organizationId: orgId, firstName: 'Cy' }, // no address
        { organizationId: orgId, firstName: 'Di', email: 'nope' }, // not an address
        { organizationId: orgId, firstName: 'Gus', email: 'gus@x.test' },
      ])
      .returning();
    // inserted afterwards, so Ann (the older contact) is the one kept when two contacts share a mailbox
    const annie = await db.insert(s.contacts).values({ organizationId: orgId, firstName: 'Annie', email: 'ANN@x.test' }).returning();
    await db.insert(s.contacts).values({ organizationId: orgId, firstName: 'Zed', email: 'zed@x.test' }); // not tagged
    await db.insert(s.contactTags).values([...people, ...annie].map((p) => ({ contactId: p.id, tagId, organizationId: orgId })));
    await db.insert(s.emailSuppressions).values({ organizationId: orgId, email: 'bob@x.test', reason: 'unsubscribed' });
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('previews who would get it: suppressed, address-less, invalid and duplicate mailboxes are skipped', async () => {
    const c = await make();
    const preview = await svc.audience({ organizationId: orgId, id: c.id });
    expect(preview).toMatchObject({ matched: 6, willReceive: 2, skipped: 4, tooLarge: false });
    expect(preview.sample.map((p) => p.email).sort()).toEqual(['ann@x.test', 'gus@x.test']);
  });

  it('rejects an unknown tag and keeps other organizations out', async () => {
    expect(await code(make({ audience: { type: 'tag', tagId: crypto.randomUUID() } }))).toBe('INVALID_AUDIENCE');
    const c = await make();
    expect(await code(svc.getById({ organizationId: otherOrgId, id: c.id }))).toBe('NOT_FOUND');
    expect(await code(svc.launch({ organizationId: otherOrgId, userId, id: c.id }))).toBe('NOT_FOUND');
  });

  it('refuses to launch without an unsubscribe link, or to an empty audience', async () => {
    const noUnsub = await make({ bodyText: 'Hi {{first_name}}' });
    expect(await code(svc.launch({ ...base(), id: noUnsub.id }))).toBe('MISSING_UNSUBSCRIBE');
    const empty = await make({ audience: { type: 'contacts', contactIds: [crypto.randomUUID()] } });
    expect(await code(svc.launch({ ...base(), id: empty.id }))).toBe('NO_RECIPIENTS');
  });

  it('launches: one personalised, tracked email per mailbox, queued together, once only', async () => {
    const c = await make();
    const launched = await svc.launch({ ...base(), id: c.id });
    expect(launched).toMatchObject({ status: 'sent', skippedCount: 4 });

    const mails = await outboxOf(c.id);
    expect(mails.map((m) => m.toEmail).sort()).toEqual(['ann@x.test', 'gus@x.test']);
    const ann = mails.find((m) => m.toEmail === 'ann@x.test')!;
    expect(ann).toMatchObject({ status: 'queued', subject: 'Hello Ann' });
    expect(ann.bodyHtml).toContain('<p>Hi Ann</p>');
    expect(ann.bodyHtml).toMatch(/href="http:\/\/localhost:4000\/api\/v1\/public\/campaigns\/c\/[0-9a-f-]{36}\/[0-9a-f]{48}"/); // tracked
    expect(ann.bodyHtml).toMatch(/<img src="http:\/\/localhost:4000\/api\/v1\/public\/campaigns\/o\/[0-9a-f]{48}\.gif"/);
    expect(ann.bodyHtml).not.toContain('shop.example.test');
    expect(ann.bodyHtml).toMatch(/href="http:\/\/localhost:5173\/unsubscribe\/[0-9a-f]{48}"/);
    expect(ann.bodyText).toMatch(/Hi Ann http:\/\/localhost:5173\/unsubscribe\/[0-9a-f]{48}/);
    expect(ann.headers).toMatchObject({ 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(ann.headers!['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:4000\/api\/v1\/public\/unsubscribe\/[0-9a-f]{48}>$/);

    expect((await recipientsOf(c.id)).map((r) => r.email).sort()).toEqual(['ann@x.test', 'gus@x.test']);
    expect(await code(svc.launch({ ...base(), id: c.id }))).toBe('CAMPAIGN_LOCKED');
    expect(await code(svc.update({ organizationId: orgId, id: c.id, input: { name: 'x' } }))).toBe('CAMPAIGN_LOCKED');

    const stats = (await svc.getById({ organizationId: orgId, id: c.id })).stats;
    expect(stats).toMatchObject({ total: 2, pending: 2, sent: 0, opened: 0, clicked: 0, unsubscribed: 0 });
  });

  it('tracks opens and clicks, and the redirect only goes where the campaign sent it', async () => {
    const c = await make();
    await svc.launch({ ...base(), id: c.id });
    const token = await tokenFor(c.id, 'ann@x.test');
    const [link] = await db.select().from(s.campaignLinks).where(eq(s.campaignLinks.campaignId, c.id));
    expect(link!.url).toBe('https://shop.example.test/sale?a=1&b=2');

    await svc.trackOpen(`${token}.gif`);
    expect(await svc.clickTarget(link!.id, token)).toBe('https://shop.example.test/sale?a=1&b=2');
    expect((await svc.getById({ organizationId: orgId, id: c.id })).stats).toMatchObject({ opened: 1, clicked: 1 });

    // a link of another campaign, and an unknown token, go nowhere
    const other = await make();
    await svc.launch({ ...base(), id: other.id });
    const [otherLink] = await db.select().from(s.campaignLinks).where(eq(s.campaignLinks.campaignId, other.id));
    expect(await code(svc.clickTarget(otherLink!.id, token))).toBe('NOT_FOUND');
    expect(await code(svc.clickTarget(link!.id, 'f'.repeat(48)))).toBe('NOT_FOUND');
    await svc.trackOpen(`${'e'.repeat(48)}.gif`); // unknown token: no error
  });

  it('unsubscribe suppresses the address, holds its waiting mail and excludes it from the next campaign', async () => {
    const first = await make();
    await svc.launch({ ...base(), id: first.id });
    const token = await tokenFor(first.id, 'gus@x.test');

    expect(await svc.unsubscribeInfo(token)).toMatchObject({ email: 'g***@x.test', unsubscribed: false });
    expect(await svc.unsubscribe(token)).toMatchObject({ unsubscribed: true });
    expect(await svc.unsubscribe(token)).toMatchObject({ unsubscribed: true }); // idempotent

    const gus = (await outboxOf(first.id)).find((m) => m.toEmail === 'gus@x.test')!;
    expect(gus).toMatchObject({ status: 'failed', lastError: 'Recipient unsubscribed' });
    expect((await recipientsOf(first.id)).find((r) => r.email === 'gus@x.test')!.unsubscribedAt).not.toBeNull();
    expect((await svc.getById({ organizationId: orgId, id: first.id })).stats.unsubscribed).toBe(1);

    const next = await make();
    await svc.launch({ ...base(), id: next.id });
    expect((await recipientsOf(next.id)).map((r) => r.email)).toEqual(['ann@x.test']);
    expect(await code(svc.unsubscribe('0'.repeat(48)))).toBe('NOT_FOUND');
    await db.delete(s.emailSuppressions).where(and(eq(s.emailSuppressions.organizationId, orgId), eq(s.emailSuppressions.email, 'gus@x.test')));
  });

  it('manages the suppression list', async () => {
    await svc.addSuppression({ organizationId: orgId, email: 'Manual@X.test' });
    await svc.addSuppression({ organizationId: orgId, email: 'manual@x.test' }); // same address again: no duplicate
    const { rows } = await svc.listSuppressions({ organizationId: orgId, page: 1, limit: 50 });
    const manual = rows.filter((r) => r.email === 'manual@x.test');
    expect(manual).toHaveLength(1);
    expect(await code(svc.removeSuppression({ organizationId: otherOrgId, id: manual[0]!.id }))).toBe('NOT_FOUND');
    await svc.removeSuppression({ organizationId: orgId, id: manual[0]!.id });
  });

  it('cancelling a sent campaign holds back what is still queued', async () => {
    const c = await make();
    await svc.launch({ ...base(), id: c.id });
    const [first] = await outboxOf(c.id);
    await db.update(s.emailOutbox).set({ status: 'sent' }).where(eq(s.emailOutbox.id, first!.id)); // pretend one already went out
    const { campaign, held } = await svc.cancel({ organizationId: orgId, id: c.id });
    expect(campaign.status).toBe('cancelled');
    expect(held).toBe(1);
    expect((await outboxOf(c.id)).map((m) => m.status).sort()).toEqual(['failed', 'sent']);
    expect(await code(svc.cancel({ organizationId: orgId, id: c.id }))).toBe('CAMPAIGN_LOCKED');
    await svc.remove({ organizationId: orgId, id: c.id });
  });

  it('schedules, unschedules and launches a due campaign from the scheduler path', async () => {
    const c = await make();
    expect(await code(svc.schedule({ organizationId: orgId, id: c.id, input: { at: new Date(Date.now() - 60_000).toISOString() } }))).toBe('INVALID_SCHEDULE');
    const scheduled = await svc.schedule({ organizationId: orgId, id: c.id, input: { at: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(scheduled.status).toBe('scheduled');
    expect((await svc.cancel({ organizationId: orgId, id: c.id })).campaign).toMatchObject({ status: 'draft', scheduledAt: null });

    await svc.schedule({ organizationId: orgId, id: c.id, input: { at: new Date(Date.now() + 3_600_000).toISOString() } });
    await db
      .update(s.emailCampaigns)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(s.emailCampaigns.id, c.id)); // the time has come
    await svc.launchScheduled({ id: c.id, organizationId: orgId, createdBy: userId });
    expect((await svc.getById({ organizationId: orgId, id: c.id })).status).toBe('sent');
    await svc.launchScheduled({ id: c.id, organizationId: orgId, createdBy: userId }); // a second instance: harmless
    expect(await outboxOf(c.id)).toHaveLength(2);
  });

  it('a scheduled campaign that cannot launch goes back to draft with the reason', async () => {
    const c = await make({ audience: { type: 'contacts', contactIds: [crypto.randomUUID()] } });
    await db
      .update(s.emailCampaigns)
      .set({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(s.emailCampaigns.id, c.id));
    await svc.launchScheduled({ id: c.id, organizationId: orgId, createdBy: userId });
    expect(await svc.getById({ organizationId: orgId, id: c.id })).toMatchObject({ status: 'draft', lastError: 'Nobody in this audience can receive email' });
  });

  it('sends a test only to users of the organization', async () => {
    const c = await make();
    expect(await code(svc.sendTest({ organizationId: orgId, id: c.id, input: { to: 'stranger@elsewhere.test' } }))).toBe('RECIPIENT_NOT_ALLOWED');
    await svc.sendTest({ organizationId: orgId, id: c.id, input: { to: userEmail } });
    const [mail] = await db
      .select()
      .from(s.emailOutbox)
      .where(and(eq(s.emailOutbox.relatedId, c.id), eq(s.emailOutbox.kind, 'campaign_test')));
    expect(mail).toMatchObject({ toEmail: userEmail, subject: '[Test] Hello Alex' });
    expect(await recipientsOf(c.id)).toHaveLength(0);
  });

  it('duplicates a campaign as a fresh draft', async () => {
    const c = await make();
    const copy = await svc.duplicate({ ...base(), id: c.id });
    expect(copy).toMatchObject({ name: 'Spring sale (copy)', status: 'draft', subject: c.subject, audience: c.audience });
    expect(copy.id).not.toBe(c.id);
  });
});
