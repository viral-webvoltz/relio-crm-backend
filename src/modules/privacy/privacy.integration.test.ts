// Privacy integration test: a person's data export, erasure (with a dry run) and log retention, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('privacy (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let svc: typeof import('./privacy.service.js').privacyService;
  let schemas: typeof import('./privacy.validation.js');
  let orgId: string;
  let otherOrgId: string;
  let staffId: string;
  let tag: string;
  let counter = 100;

  const EMAIL = 'Pat.Person@Example.test';
  const code = async (work: Promise<unknown>) =>
    (
      (await work.then(
        () => null,
        (err: unknown) => err,
      )) as { code?: string } | null
    )?.code;
  const exists = async (table: PgTable & { id: AnyPgColumn }, id: string) => (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length > 0;

  type Footprint = Awaited<ReturnType<typeof seedPerson>>;

  // One person with something in nearly every part of the system.
  async function seedPerson(organization: string, email: string, name: string) {
    const [contact] = await db
      .insert(s.contacts)
      .values({ organizationId: organization, firstName: name, lastName: 'Person', email, phone: '555-0100', notes: `secret notes about ${name}` })
      .returning();
    const contactId = contact!.id;
    const [lead] = await db.insert(s.leads).values({ organizationId: organization, firstName: name, email, notes: 'came from the website' }).returning();
    const [theTag] = await db
      .insert(s.tags)
      .values({ organizationId: organization, name: `t-${crypto.randomUUID().slice(0, 6)}`, color: '#000' })
      .returning();
    await db.insert(s.contactTags).values({ contactId, tagId: theTag!.id, organizationId: organization });
    const [activity] = await db
      .insert(s.activities)
      .values({
        organizationId: organization,
        type: 'note',
        subject: `Call with ${name}`,
        body: 'discussed health issue',
        relatedType: 'contact',
        relatedId: contactId,
      })
      .returning();
    const [task] = await db
      .insert(s.tasks)
      .values({ organizationId: organization, title: `Follow up with ${name}`, relatedType: 'lead', relatedId: lead!.id })
      .returning();

    const [product] = await db.insert(s.products).values({ organizationId: organization, name: 'Widget', priceMinor: 1000, trackInventory: false }).returning();
    const [order] = await db
      .insert(s.orders)
      .values({ organizationId: organization, orderNumber: counter++, currency: 'USD', totalMinor: 1000, contactId, customerName: `${name} Person` })
      .returning();
    await db.insert(s.orderItems).values({
      organizationId: organization,
      orderId: order!.id,
      productId: product!.id,
      productName: 'Widget',
      unitPriceMinor: 1000,
      quantity: 1,
      lineTotalMinor: 1000,
    });
    const [invoice] = await db
      .insert(s.invoices)
      .values({
        organizationId: organization,
        invoiceNumber: counter++,
        orderId: order!.id,
        currency: 'USD',
        totalMinor: 1000,
        paidMinor: 1000,
        status: 'paid',
        dueDate: '2030-01-01',
        customerName: `${name} Person`,
      })
      .returning();
    const [payment] = await db
      .insert(s.payments)
      .values({ organizationId: organization, invoiceId: invoice!.id, amountMinor: 1000, method: 'card' })
      .returning();
    const [quote] = await db
      .insert(s.quotes)
      .values({
        organizationId: organization,
        quoteNumber: counter++,
        currency: 'USD',
        contactId,
        customerName: `${name} Person`,
        status: 'sent',
        publicTokenHash: crypto.randomUUID().replace(/-/g, ''),
      })
      .returning();
    const [sub] = await db
      .insert(s.subscriptions)
      .values({
        organizationId: organization,
        name: 'Plan',
        currency: 'USD',
        contactId,
        customerName: `${name} Person`,
        intervalUnit: 'month',
        startOn: '2030-01-01',
        nextRunOn: '2030-01-01',
      })
      .returning();

    const [ticket] = await db
      .insert(s.supportTickets)
      .values({ organizationId: organization, ticketNumber: counter++, subject: 'Help', slaDueAt: new Date(), contactId, customerName: `${name} Person` })
      .returning();
    const [customerMsg] = await db
      .insert(s.ticketMessages)
      .values({
        organizationId: organization,
        ticketId: ticket!.id,
        authorType: 'customer',
        authorContactId: contactId,
        body: `My phone number is 555-0100, ${name}`,
      })
      .returning();
    const [staffMsg] = await db
      .insert(s.ticketMessages)
      .values({ organizationId: organization, ticketId: ticket!.id, authorType: 'staff', authorUserId: staffId, body: 'We are looking into it' })
      .returning();

    const [account] = await db
      .insert(s.customerAccounts)
      .values({ organizationId: organization, contactId, email, passwordHash: 'HASH-MUST-NEVER-LEAK' })
      .returning();
    const [portalDoc] = await db
      .insert(s.portalDocuments)
      .values({
        organizationId: organization,
        contactId,
        name: 'Passport',
        fileName: 'passport.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        content: Buffer.from('PDF'),
      })
      .returning();
    const [appointment] = await db
      .insert(s.portalAppointments)
      .values({ organizationId: organization, contactId, subject: 'Consultation', startsAt: new Date() })
      .returning();
    const [doc] = await db
      .insert(s.documents)
      .values({ organizationId: organization, entityType: 'contact', entityId: contactId, name: 'Contract' })
      .returning();
    await db.insert(s.documentVersions).values({
      organizationId: organization,
      documentId: doc!.id,
      version: 1,
      fileName: 'c.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      content: Buffer.from('PDF'),
    });

    const [campaign] = await db
      .insert(s.emailCampaigns)
      .values({ organizationId: organization, name: 'News', subject: 's', bodyHtml: 'h', bodyText: 't', audience: { type: 'all' } })
      .returning();
    const [recipient] = await db
      .insert(s.campaignRecipients)
      .values({
        organizationId: organization,
        campaignId: campaign!.id,
        contactId,
        email: email.toLowerCase(),
        token: crypto.randomUUID().replace(/-/g, '') + 'ab',
      })
      .returning();
    const [mail] = await db
      .insert(s.emailOutbox)
      .values({ organizationId: organization, kind: 'invoice', toEmail: email, subject: 'Your invoice', bodyHtml: '<p>hi</p>', bodyText: 'hi', status: 'sent' })
      .returning();

    const [endpoint] = await db
      .insert(s.webhookEndpoints)
      .values({ organizationId: organization, url: 'https://hooks.example.test', secret: 's', events: ['*'] })
      .returning();
    const [delivery] = await db
      .insert(s.webhookDeliveries)
      .values({ organizationId: organization, endpointId: endpoint!.id, event: 'contacts.update', payload: { id: contactId, changes: { email } } })
      .returning();
    const [wfEvent] = await db
      .insert(s.workflowEvents)
      .values({ organizationId: organization, event: 'contacts.update', actorId: staffId, recordId: contactId, values: { email }, changed: [] })
      .returning();
    const [auditRow] = await db
      .insert(s.auditLogs)
      .values({
        organizationId: organization,
        action: 'update',
        targetType: 'contacts',
        targetId: contactId,
        metadata: { changes: { email, phone: '555-0100' } },
      })
      .returning();

    return {
      contactId,
      leadId: lead!.id,
      activityId: activity!.id,
      taskId: task!.id,
      orderId: order!.id,
      invoiceId: invoice!.id,
      paymentId: payment!.id,
      quoteId: quote!.id,
      subscriptionId: sub!.id,
      ticketId: ticket!.id,
      customerMsgId: customerMsg!.id,
      staffMsgId: staffMsg!.id,
      accountId: account!.id,
      portalDocId: portalDoc!.id,
      appointmentId: appointment!.id,
      documentId: doc!.id,
      recipientId: recipient!.id,
      mailId: mail!.id,
      deliveryId: delivery!.id,
      wfEventId: wfEvent!.id,
      auditId: auditRow!.id,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
    ({ privacyService: svc } = await import('./privacy.service.js'));
    schemas = await import('./privacy.validation.js');

    tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `pv-${tag}`, slug: `pv-${tag}` },
        { name: `pv2-${tag}`, slug: `pv2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    staffId = (
      await db
        .insert(s.users)
        .values({ organizationId: orgId, email: `staff-${tag}@example.test`, fullName: 'Privacy Officer', passwordHash: 'x' })
        .returning()
    )[0]!.id;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('asks for a subject, and for a second confirmation before erasing for real', () => {
    expect(schemas.exportSubjectSchema.safeParse({}).success).toBe(false);
    expect(schemas.exportSubjectSchema.safeParse({ email: 'a@b.test' }).success).toBe(true);
    expect(schemas.eraseSubjectSchema.safeParse({ email: 'a@b.test' }).success).toBe(false); // no confirm
    expect(schemas.eraseSubjectSchema.safeParse({ email: 'a@b.test', confirm: 'other@b.test' }).success).toBe(false);
    expect(schemas.eraseSubjectSchema.safeParse({ email: 'a@b.test', confirm: 'A@B.test' }).success).toBe(true); // case does not matter
    expect(schemas.eraseSubjectSchema.safeParse({ email: 'a@b.test', dryRun: true }).success).toBe(true); // a dry run needs no confirmation
    expect(schemas.retentionSchema.safeParse({ auditLogDays: 5, emailLogDays: null, notificationDays: null }).success).toBe(false); // a typo must not wipe the log
    expect(schemas.retentionSchema.safeParse({ auditLogDays: 90, emailLogDays: null, notificationDays: 30 }).success).toBe(true);
  });

  describe('export and erasure', () => {
    let pat: Footprint;
    let bystander: Footprint;
    let elsewhere: Footprint;

    beforeAll(async () => {
      pat = await seedPerson(orgId, EMAIL, 'Pat');
      bystander = await seedPerson(orgId, 'someone.else@example.test', 'Sam');
      elsewhere = await seedPerson(otherOrgId, EMAIL, 'Pat'); // same address, a different organization: a different data controller
      await db.insert(s.emailSuppressions).values({ organizationId: orgId, email: EMAIL.toLowerCase(), reason: 'unsubscribed' });
    });

    it('finds the person by email (any case) or by contact, and nobody from another organization', async () => {
      const byEmail = await svc.resolve(orgId, { email: 'pat.person@example.test' });
      expect(byEmail).toMatchObject({ contactIds: [pat.contactId], leadIds: [pat.leadId] });
      expect((await svc.resolve(orgId, { contactId: pat.contactId })).leadIds).toEqual([pat.leadId]); // found through the address on the contact
      expect(await code(svc.resolve(orgId, { email: 'nobody@example.test' }))).toBe('NOT_FOUND');
      expect(await code(svc.resolve(otherOrgId, { contactId: pat.contactId }))).toBe('NOT_FOUND');
    });

    it('exports everything held about the person, and nothing about anyone else', async () => {
      const bundle = await svc.export({ organizationId: orgId, actorId: staffId, input: { email: EMAIL } });
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

      expect(bundle.subject.emails).toEqual([EMAIL.toLowerCase()]);
      expect(ids(bundle.contacts)).toEqual([pat.contactId]);
      expect(ids(bundle.leads)).toEqual([pat.leadId]);
      expect(bundle.tags).toHaveLength(1);
      expect(ids(bundle.notesAndActivities)).toEqual([pat.activityId]);
      expect(ids(bundle.tasks)).toEqual([pat.taskId]);
      expect(ids(bundle.orders)).toEqual([pat.orderId]);
      expect(bundle.orderItems).toHaveLength(1);
      expect(ids(bundle.invoices)).toEqual([pat.invoiceId]);
      expect(ids(bundle.payments)).toEqual([pat.paymentId]);
      expect(ids(bundle.quotes)).toEqual([pat.quoteId]);
      expect(ids(bundle.subscriptions)).toEqual([pat.subscriptionId]);
      expect(ids(bundle.tickets)).toEqual([pat.ticketId]);
      expect(ids(bundle.ticketMessages).sort()).toEqual([pat.customerMsgId, pat.staffMsgId].sort());
      expect(ids(bundle.portalAccounts)).toEqual([pat.accountId]);
      expect(ids(bundle.portalDocuments)).toEqual([pat.portalDocId]);
      expect(ids(bundle.portalAppointments)).toEqual([pat.appointmentId]);
      expect(ids(bundle.attachedDocuments)).toEqual([pat.documentId]);
      expect(bundle.campaignEmails).toHaveLength(1);
      expect(bundle.emailsSent).toHaveLength(1);

      const text = JSON.stringify(bundle);
      for (const secret of ['HASH-MUST-NEVER-LEAK', 'publicTokenHash', 'passwordHash']) expect(text).not.toContain(secret); // no credentials
      expect(text).not.toContain('"token"'); // no tracking tokens
      expect(text).not.toContain('"content"'); // no file bytes
      for (const other of [bystander, elsewhere]) expect(text).not.toContain(other.contactId); // nobody else's data
      expect(text).not.toContain('Sam');
    });

    it('records the export without writing down who it was about', async () => {
      const entries = await db
        .select()
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.organizationId, orgId), eq(s.auditLogs.action, 'privacy.exported')));
      expect(entries.length).toBeGreaterThan(0);
      expect(JSON.stringify(entries)).not.toContain('example.test');
      expect(JSON.stringify(entries)).not.toContain(pat.contactId);
    });

    it('a dry run reports what would go and changes nothing', async () => {
      const result = await svc.erase({ organizationId: orgId, actorId: staffId, input: { email: EMAIL, dryRun: true } as never });
      expect(result.dryRun).toBe(true);
      expect(result.counts).toMatchObject({
        contactsDeleted: 1,
        leadsDeleted: 1,
        activitiesDeleted: 1,
        tasksDeleted: 1,
        ordersAnonymised: 1,
        invoicesAnonymised: 1,
        ticketMessagesScrubbed: 1,
        portalAccounts: 1,
      });
      expect(await exists(s.contacts, pat.contactId)).toBe(true);
      expect(await exists(s.leads, pat.leadId)).toBe(true);
      expect(await exists(s.activities, pat.activityId)).toBe(true);
      const [msg] = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.id, pat.customerMsgId));
      expect(msg!.body).toContain('555-0100'); // untouched
      expect(
        (
          await db
            .select()
            .from(s.auditLogs)
            .where(and(eq(s.auditLogs.organizationId, orgId), eq(s.auditLogs.action, 'privacy.erased')))
        ).length,
      ).toBe(0);
    });

    it('erases the person: personal records go, accounting records stay without the name, and nobody else is touched', async () => {
      const result = await svc.erase({ organizationId: orgId, actorId: staffId, input: { email: EMAIL, confirm: EMAIL, dryRun: false } as never });
      expect(result.dryRun).toBe(false);

      // gone
      for (const [table, id] of [
        [s.contacts, pat.contactId],
        [s.leads, pat.leadId],
        [s.activities, pat.activityId],
        [s.tasks, pat.taskId],
        [s.customerAccounts, pat.accountId],
        [s.portalDocuments, pat.portalDocId],
        [s.portalAppointments, pat.appointmentId],
        [s.documents, pat.documentId],
        [s.campaignRecipients, pat.recipientId],
        [s.emailOutbox, pat.mailId],
        [s.webhookDeliveries, pat.deliveryId],
        [s.workflowEvents, pat.wfEventId],
      ] as const)
        expect(await exists(table, id), String(id)).toBe(false);
      expect(await db.select().from(s.documentVersions).where(eq(s.documentVersions.documentId, pat.documentId))).toEqual([]);

      // kept for the books, with the name taken off and the link to the person cut
      const [order] = await db.select().from(s.orders).where(eq(s.orders.id, pat.orderId));
      expect(order).toMatchObject({ customerName: 'Erased customer', contactId: null, totalMinor: 1000 });
      const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, pat.invoiceId));
      expect(invoice).toMatchObject({ customerName: 'Erased customer', totalMinor: 1000, paidMinor: 1000 });
      expect(await exists(s.payments, pat.paymentId)).toBe(true);
      const [quote] = await db.select().from(s.quotes).where(eq(s.quotes.id, pat.quoteId));
      expect(quote).toMatchObject({ customerName: 'Erased customer', contactId: null, publicTokenHash: null }); // the old link is dead
      const [sub] = await db.select().from(s.subscriptions).where(eq(s.subscriptions.id, pat.subscriptionId));
      expect(sub).toMatchObject({ customerName: 'Erased customer', status: 'cancelled', nextRunOn: null });

      // the conversation stays, minus what the person wrote
      const [ticket] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, pat.ticketId));
      expect(ticket).toMatchObject({ customerName: 'Erased customer', contactId: null });
      const [customerMsg] = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.id, pat.customerMsgId));
      expect(customerMsg!.body).toBe('Removed at the data subject’s request');
      const [staffMsg] = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.id, pat.staffMsgId));
      expect(staffMsg!.body).toBe('We are looking into it');

      // the audit trail says something happened, not what the data was
      const [audited] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.id, pat.auditId));
      expect(audited!.metadata).toEqual({ erased: true });
      const erasedEntries = await db
        .select()
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.organizationId, orgId), eq(s.auditLogs.action, 'privacy.erased')));
      expect(erasedEntries).toHaveLength(1);
      expect(JSON.stringify(erasedEntries)).not.toContain('example.test');

      // the do-not-contact record is kept on purpose, so the address is not mailed again
      expect((await db.select().from(s.emailSuppressions).where(eq(s.emailSuppressions.organizationId, orgId))).map((r) => r.email)).toContain(
        EMAIL.toLowerCase(),
      );

      // somebody else in the same organization, and the same address in another organization: untouched
      for (const person of [bystander, elsewhere]) {
        for (const [table, id] of [
          [s.contacts, person.contactId],
          [s.leads, person.leadId],
          [s.activities, person.activityId],
          [s.customerAccounts, person.accountId],
          [s.emailOutbox, person.mailId],
          [s.webhookDeliveries, person.deliveryId],
        ] as const) {
          expect(await exists(table, id), String(id)).toBe(true);
        }
        const [theirOrder] = await db.select().from(s.orders).where(eq(s.orders.id, person.orderId));
        expect(theirOrder!.customerName).toMatch(/Person$/);
        expect(theirOrder!.contactId).toBe(person.contactId);
      }
      const [theirAudit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.id, bystander.auditId));
      expect(JSON.stringify(theirAudit!.metadata)).toContain('someone.else@example.test');
    });

    it('a second request for the same person finds nobody', async () => {
      expect(await code(svc.erase({ organizationId: orgId, actorId: staffId, input: { email: EMAIL, confirm: EMAIL, dryRun: false } as never }))).toBe(
        'NOT_FOUND',
      );
    });
  });

  describe('retention', () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    const recent = new Date(Date.now() - 5 * 86_400_000);

    it('keeps everything by default and stores a policy', async () => {
      expect(await svc.getRetention(orgId)).toEqual({ auditLogDays: null, emailLogDays: null, notificationDays: null });
      expect(await svc.putRetention({ organizationId: orgId, userId: staffId, input: { auditLogDays: 90, emailLogDays: 60, notificationDays: 30 } })).toEqual({
        auditLogDays: 90,
        emailLogDays: 60,
        notificationDays: 30,
      });
      expect((await svc.getRetention(otherOrgId)).auditLogDays).toBeNull();
    });

    it('purges only what is older than the limit, only for organizations with a policy, and never unread or unsent items', async () => {
      const mine = { organizationId: orgId };
      const theirs = { organizationId: otherOrgId };
      const [oldAudit, newAudit, theirOldAudit] = await db
        .insert(s.auditLogs)
        .values([
          { ...mine, action: 'x', targetType: 't', createdAt: old },
          { ...mine, action: 'y', targetType: 't', createdAt: recent },
          { ...theirs, action: 'z', targetType: 't', createdAt: old },
        ])
        .returning();
      const mail = (extra: Record<string, unknown>) => ({ kind: 'k', toEmail: 'x@example.test', subject: 's', bodyHtml: 'h', bodyText: 't', ...extra });
      const [oldSent, oldQueued, newSent, theirOldSent] = await db
        .insert(s.emailOutbox)
        .values([
          { ...mine, ...mail({ status: 'sent', createdAt: old }) },
          { ...mine, ...mail({ status: 'queued', createdAt: old }) },
          { ...mine, ...mail({ status: 'sent', createdAt: recent }) },
          { ...theirs, ...mail({ status: 'sent', createdAt: old }) },
        ] as never)
        .returning();
      const note = (extra: Record<string, unknown>) => ({ userId: staffId, type: 't', title: 'n', ...extra });
      const [oldRead, oldUnread, newRead] = await db
        .insert(s.notifications)
        .values([
          { ...mine, ...note({ readAt: old, createdAt: old }) },
          { ...mine, ...note({ createdAt: old }) },
          { ...mine, ...note({ readAt: recent, createdAt: recent }) },
        ] as never)
        .returning();

      const purged = await svc.purgeExpired();
      expect(purged.auditLogs).toBeGreaterThanOrEqual(1);
      expect(purged.emailLogs).toBeGreaterThanOrEqual(1);
      expect(purged.notifications).toBeGreaterThanOrEqual(1);

      expect(await exists(s.auditLogs, oldAudit!.id)).toBe(false);
      expect(await exists(s.auditLogs, newAudit!.id)).toBe(true);
      expect(await exists(s.auditLogs, theirOldAudit!.id)).toBe(true); // no policy there
      expect(await exists(s.emailOutbox, oldSent!.id)).toBe(false);
      expect(await exists(s.emailOutbox, oldQueued!.id)).toBe(true); // still waiting to go out
      expect(await exists(s.emailOutbox, newSent!.id)).toBe(true);
      expect(await exists(s.emailOutbox, theirOldSent!.id)).toBe(true);
      expect(await exists(s.notifications, oldRead!.id)).toBe(false);
      expect(await exists(s.notifications, oldUnread!.id)).toBe(true); // never read: not for us to discard
      expect(await exists(s.notifications, newRead!.id)).toBe(true);
    });

    it('switching a limit off keeps that log again', async () => {
      await svc.putRetention({ organizationId: orgId, userId: staffId, input: { auditLogDays: null, emailLogDays: null, notificationDays: null } });
      const [row] = await db.insert(s.auditLogs).values({ organizationId: orgId, action: 'keep', targetType: 't', createdAt: old }).returning();
      await svc.purgeExpired();
      expect(await exists(s.auditLogs, row!.id)).toBe(true);
    });
  });
});
