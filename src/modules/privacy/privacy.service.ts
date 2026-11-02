import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db, withTransaction } from '@/config/database.js';
import {
  activities,
  campaignRecipients,
  contactTags,
  contacts,
  customerAccounts,
  deals,
  documents,
  emailOutbox,
  invoices,
  leads,
  orderItems,
  orders,
  payments,
  portalAppointments,
  portalDocuments,
  quoteItems,
  quotes,
  refunds,
  retentionPolicies,
  subscriptionItems,
  subscriptionRuns,
  subscriptions,
  supportTickets,
  tags,
  tasks,
  ticketMessages,
} from '@/database/schema/index.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import type { EraseInput, RetentionInput, SubjectInput } from './privacy.validation.js';

const REMOVED = 'Removed at the data subject’s request';
const ERASED_NAME = 'Erased customer';
const PURGE_BATCH = 5_000;
const PURGE_MAX_BATCHES = 20;

type Subject = { contactIds: string[]; leadIds: string[]; emails: string[] };

// inArray refuses an empty list in some versions; "none of these" is simply false.
const anyOf = (column: AnyColumn, ids: readonly string[]): SQL => (ids.length ? inArray(column, [...ids]) : sql`false`);
const lowerIn = (column: AnyColumn, emails: readonly string[]): SQL =>
  emails.length
    ? sql`lower(${column}) in (${sql.join(
        emails.map((e) => sql`${e}`),
        sql`, `,
      )})`
    : sql`false`;
const fingerprint = (value: string) => createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 16); // so the log can say "this request" without storing who

// Thrown inside the erase transaction to roll it back after a dry run; carries what would have happened.
class DryRun extends Error {
  constructor(readonly counts: Record<string, number>) {
    super('dry run');
  }
}

class PrivacyService {
  // ---- who ----

  // Everything that is the same person: the contacts and leads that use this email (or this contact), including trashed ones.
  async resolve(organizationId: string, { email, contactId }: SubjectInput): Promise<Subject> {
    const address = email?.trim().toLowerCase();
    const contactRows = await db
      .select({ id: contacts.id, email: contacts.email })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          or(contactId ? eq(contacts.id, contactId) : undefined, address ? sql`lower(${contacts.email}) = ${address}` : undefined),
        ),
      );
    const contactIds = contactRows.map((c) => c.id);
    const emails = new Set<string>([...(address ? [address] : []), ...contactRows.flatMap((c) => (c.email ? [c.email.toLowerCase()] : []))]);

    const leadMatch = or(
      emails.size ? lowerIn(leads.email, [...emails]) : undefined,
      contactIds.length ? inArray(leads.convertedContactId, contactIds) : undefined,
    );
    const leadRows = leadMatch
      ? await db
          .select({ id: leads.id, email: leads.email })
          .from(leads)
          .where(and(eq(leads.organizationId, organizationId), leadMatch))
      : [];
    for (const l of leadRows) if (l.email) emails.add(l.email.toLowerCase());

    if (contactIds.length === 0 && leadRows.length === 0) throw new NotFoundError('Nobody matches that email or contact');
    return { contactIds, leadIds: leadRows.map((l) => l.id), emails: [...emails] };
  }

  // ---- export (the right of access) ----

  // Everything held about the person, as one document. Credentials, file contents and tracking tokens are left out.
  async export({ organizationId, actorId, input }: { organizationId: string; actorId: string; input: SubjectInput }) {
    const subject = await this.resolve(organizationId, input);
    const org = (table: { organizationId: AnyColumn }) => eq(table.organizationId, organizationId);
    const people = [...subject.contactIds, ...subject.leadIds];

    const orderRows = await db
      .select()
      .from(orders)
      .where(and(org(orders), anyOf(orders.contactId, subject.contactIds)));
    const orderIds = orderRows.map((o) => o.id);
    const invoiceRows = await db
      .select()
      .from(invoices)
      .where(and(org(invoices), anyOf(invoices.orderId, orderIds)));
    const paymentRows = await db
      .select()
      .from(payments)
      .where(
        anyOf(
          payments.invoiceId,
          invoiceRows.map((i) => i.id),
        ),
      );
    const quoteRows = await db
      .select({ ...quoteColumns })
      .from(quotes)
      .where(and(org(quotes), anyOf(quotes.contactId, subject.contactIds)));
    const subscriptionRows = await db
      .select()
      .from(subscriptions)
      .where(and(org(subscriptions), anyOf(subscriptions.contactId, subject.contactIds)));
    const ticketRows = await db
      .select()
      .from(supportTickets)
      .where(and(org(supportTickets), anyOf(supportTickets.contactId, subject.contactIds)));

    const bundle = {
      generatedAt: new Date().toISOString(),
      subject: { emails: subject.emails, contactIds: subject.contactIds, leadIds: subject.leadIds },
      contacts: await db
        .select()
        .from(contacts)
        .where(and(org(contacts), anyOf(contacts.id, subject.contactIds))),
      leads: await db
        .select()
        .from(leads)
        .where(and(org(leads), anyOf(leads.id, subject.leadIds))),
      tags: await db
        .select({ contactId: contactTags.contactId, tag: tags.name })
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(anyOf(contactTags.contactId, subject.contactIds)),
      notesAndActivities: await db
        .select()
        .from(activities)
        .where(and(org(activities), inArray(activities.relatedType, ['contact', 'lead']), anyOf(activities.relatedId, people))),
      tasks: await db
        .select()
        .from(tasks)
        .where(and(org(tasks), inArray(tasks.relatedType, ['contact', 'lead']), anyOf(tasks.relatedId, people))),
      deals: await db
        .select()
        .from(deals)
        .where(and(org(deals), anyOf(deals.contactId, subject.contactIds))),
      orders: orderRows,
      orderItems: await db.select().from(orderItems).where(anyOf(orderItems.orderId, orderIds)),
      invoices: invoiceRows,
      payments: paymentRows,
      refunds: await db
        .select()
        .from(refunds)
        .where(
          anyOf(
            refunds.paymentId,
            paymentRows.map((p) => p.id),
          ),
        ),
      quotes: quoteRows,
      quoteItems: await db
        .select()
        .from(quoteItems)
        .where(
          anyOf(
            quoteItems.quoteId,
            quoteRows.map((q) => q.id),
          ),
        ),
      subscriptions: subscriptionRows,
      subscriptionItems: await db
        .select()
        .from(subscriptionItems)
        .where(
          anyOf(
            subscriptionItems.subscriptionId,
            subscriptionRows.map((s) => s.id),
          ),
        ),
      subscriptionRuns: await db
        .select()
        .from(subscriptionRuns)
        .where(
          anyOf(
            subscriptionRuns.subscriptionId,
            subscriptionRows.map((s) => s.id),
          ),
        ),
      tickets: ticketRows,
      ticketMessages: await db
        .select()
        .from(ticketMessages)
        .where(
          anyOf(
            ticketMessages.ticketId,
            ticketRows.map((t) => t.id),
          ),
        ),
      portalAccounts: await db
        .select({
          id: customerAccounts.id,
          contactId: customerAccounts.contactId,
          email: customerAccounts.email,
          isActive: customerAccounts.isActive,
          lastLoginAt: customerAccounts.lastLoginAt,
          createdAt: customerAccounts.createdAt,
        })
        .from(customerAccounts)
        .where(anyOf(customerAccounts.contactId, subject.contactIds)),
      portalDocuments: await db
        .select({
          id: portalDocuments.id,
          contactId: portalDocuments.contactId,
          name: portalDocuments.name,
          fileName: portalDocuments.fileName,
          mimeType: portalDocuments.mimeType,
          sizeBytes: portalDocuments.sizeBytes,
          createdAt: portalDocuments.createdAt,
        })
        .from(portalDocuments)
        .where(anyOf(portalDocuments.contactId, subject.contactIds)),
      portalAppointments: await db.select().from(portalAppointments).where(anyOf(portalAppointments.contactId, subject.contactIds)),
      attachedDocuments: await db
        .select({ id: documents.id, entityType: documents.entityType, entityId: documents.entityId, name: documents.name, createdAt: documents.createdAt })
        .from(documents)
        .where(and(org(documents), inArray(documents.entityType, ['contact', 'lead']), anyOf(documents.entityId, people))),
      campaignEmails: await db
        .select({
          campaignId: campaignRecipients.campaignId,
          email: campaignRecipients.email,
          openedAt: campaignRecipients.openedAt,
          clickedAt: campaignRecipients.clickedAt,
          unsubscribedAt: campaignRecipients.unsubscribedAt,
        })
        .from(campaignRecipients)
        .where(and(org(campaignRecipients), or(anyOf(campaignRecipients.contactId, subject.contactIds), lowerIn(campaignRecipients.email, subject.emails)))),
      emailsSent: await db
        .select({
          kind: emailOutbox.kind,
          toEmail: emailOutbox.toEmail,
          subject: emailOutbox.subject,
          status: emailOutbox.status,
          createdAt: emailOutbox.createdAt,
          sentAt: emailOutbox.sentAt,
        })
        .from(emailOutbox)
        .where(and(org(emailOutbox), lowerIn(emailOutbox.toEmail, subject.emails))),
    };
    await audit({
      organizationId,
      actorUserId: actorId,
      action: 'privacy.exported',
      targetType: 'privacy',
      metadata: { subject: fingerprint(input.email ?? input.contactId ?? ''), contacts: subject.contactIds.length, leads: subject.leadIds.length },
    });
    return bundle;
  }

  // ---- erase (the right to be forgotten) ----

  // Removes the person: their contact and lead records, notes, tasks, portal login and files, campaign and email logs. What the business must
  // keep for accounting (orders, invoices, payments, quotes, subscriptions) stays, with the name taken off. Nothing is half done: it all happens
  // in one transaction, and `dryRun` runs it and then rolls it back so the counts can be checked first.
  async erase({ organizationId, actorId, input }: { organizationId: string; actorId: string; input: EraseInput }) {
    const subject = await this.resolve(organizationId, input);
    try {
      const counts = await withTransaction(async (tx) => {
        const n: Record<string, number> = {};
        const org = (table: { organizationId: AnyColumn }) => eq(table.organizationId, organizationId);
        const people = [...subject.contactIds, ...subject.leadIds];

        // What the person wrote in support conversations goes; the staff replies around it stay.
        n.ticketMessagesScrubbed = (
          await tx
            .update(ticketMessages)
            .set({ body: REMOVED })
            .where(and(org(ticketMessages), anyOf(ticketMessages.authorContactId, subject.contactIds)))
            .returning({ id: ticketMessages.id })
        ).length;
        n.ticketsAnonymised = (
          await tx
            .update(supportTickets)
            .set({ customerName: ERASED_NAME })
            .where(and(org(supportTickets), anyOf(supportTickets.contactId, subject.contactIds)))
            .returning({ id: supportTickets.id })
        ).length;

        // Accounting records are kept but no longer say who.
        const orderRows = await tx
          .update(orders)
          .set({ customerName: ERASED_NAME })
          .where(and(org(orders), anyOf(orders.contactId, subject.contactIds)))
          .returning({ id: orders.id });
        n.ordersAnonymised = orderRows.length;
        n.invoicesAnonymised = (
          await tx
            .update(invoices)
            .set({ customerName: ERASED_NAME })
            .where(
              and(
                org(invoices),
                anyOf(
                  invoices.orderId,
                  orderRows.map((o) => o.id),
                ),
              ),
            )
            .returning({ id: invoices.id })
        ).length;
        // A quote link in an old email must stop working.
        n.quotesAnonymised = (
          await tx
            .update(quotes)
            .set({ customerName: ERASED_NAME, publicTokenHash: null })
            .where(and(org(quotes), anyOf(quotes.contactId, subject.contactIds)))
            .returning({ id: quotes.id })
        ).length;
        n.subscriptionsAnonymised = (
          await tx
            .update(subscriptions)
            .set({ customerName: ERASED_NAME })
            .where(and(org(subscriptions), anyOf(subscriptions.contactId, subject.contactIds)))
            .returning({ id: subscriptions.id })
        ).length;
        // Nobody left to bill.
        n.subscriptionsCancelled = (
          await tx
            .update(subscriptions)
            .set({ status: 'cancelled', nextRunOn: null })
            .where(and(org(subscriptions), anyOf(subscriptions.contactId, subject.contactIds), inArray(subscriptions.status, ['active', 'paused'])))
            .returning({ id: subscriptions.id })
        ).length;

        n.activitiesDeleted = (
          await tx
            .delete(activities)
            .where(and(org(activities), inArray(activities.relatedType, ['contact', 'lead']), anyOf(activities.relatedId, people)))
            .returning({ id: activities.id })
        ).length;
        n.tasksDeleted = (
          await tx
            .delete(tasks)
            .where(and(org(tasks), inArray(tasks.relatedType, ['contact', 'lead']), anyOf(tasks.relatedId, people)))
            .returning({ id: tasks.id })
        ).length;
        n.attachedDocumentsDeleted = (
          await tx
            .delete(documents)
            .where(and(org(documents), inArray(documents.entityType, ['contact', 'lead']), anyOf(documents.entityId, people)))
            .returning({ id: documents.id })
        ).length;
        n.campaignRecordsDeleted = (
          await tx
            .delete(campaignRecipients)
            .where(and(org(campaignRecipients), or(anyOf(campaignRecipients.contactId, subject.contactIds), lowerIn(campaignRecipients.email, subject.emails))))
            .returning({ id: campaignRecipients.id })
        ).length;
        n.emailLogsDeleted = (
          await tx
            .delete(emailOutbox)
            .where(and(org(emailOutbox), lowerIn(emailOutbox.toEmail, subject.emails)))
            .returning({ id: emailOutbox.id })
        ).length;

        // Copies that sit in queues and logs.
        const ids = sql.join(
          people.map((id) => sql`${id}`),
          sql`, `,
        );
        if (people.length) {
          n.webhookPayloadsDeleted =
            (await tx.execute(sql`delete from webhook_deliveries where organization_id = ${organizationId} and payload->>'id' in (${ids})`)).rowCount ?? 0;
          n.workflowEventsDeleted =
            (await tx.execute(sql`delete from workflow_events where organization_id = ${organizationId} and record_id::text in (${ids})`)).rowCount ?? 0;
          // The audit trail keeps that something happened to a record, but not what the person's data was.
          n.auditEntriesScrubbed =
            (
              await tx.execute(
                sql`update audit_logs set metadata = jsonb_build_object('erased', true) where organization_id = ${organizationId} and target_id::text in (${ids})`,
              )
            ).rowCount ?? 0;
        }

        // What goes with the contact itself (portal login and its sessions, portal files, appointments, tags) is removed by the database.
        n.portalAccounts = (
          await tx.select({ id: customerAccounts.id }).from(customerAccounts).where(anyOf(customerAccounts.contactId, subject.contactIds))
        ).length;
        n.portalDocuments = (
          await tx.select({ id: portalDocuments.id }).from(portalDocuments).where(anyOf(portalDocuments.contactId, subject.contactIds))
        ).length;
        n.portalAppointments = (
          await tx.select({ id: portalAppointments.id }).from(portalAppointments).where(anyOf(portalAppointments.contactId, subject.contactIds))
        ).length;
        n.leadsDeleted = (
          await tx
            .delete(leads)
            .where(and(org(leads), anyOf(leads.id, subject.leadIds)))
            .returning({ id: leads.id })
        ).length;
        n.contactsDeleted = (
          await tx
            .delete(contacts)
            .where(and(org(contacts), anyOf(contacts.id, subject.contactIds)))
            .returning({ id: contacts.id })
        ).length;

        if (input.dryRun) throw new DryRun(n);
        await audit(
          {
            organizationId,
            actorUserId: actorId,
            action: 'privacy.erased',
            targetType: 'privacy',
            metadata: { subject: fingerprint(input.email ?? input.contactId ?? ''), counts: n },
          },
          tx,
        );
        return n;
      });
      return { dryRun: false, counts };
    } catch (err) {
      if (err instanceof DryRun) return { dryRun: true, counts: err.counts };
      throw err;
    }
  }

  // ---- retention ----

  async getRetention(organizationId: string) {
    const [row] = await db.select().from(retentionPolicies).where(eq(retentionPolicies.organizationId, organizationId));
    return { auditLogDays: row?.auditLogDays ?? null, emailLogDays: row?.emailLogDays ?? null, notificationDays: row?.notificationDays ?? null };
  }

  async putRetention({ organizationId, userId, input }: { organizationId: string; userId: string; input: RetentionInput }) {
    const values = { ...input, updatedBy: userId, updatedAt: new Date() };
    await db
      .insert(retentionPolicies)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({ target: retentionPolicies.organizationId, set: values });
    await audit({ organizationId, actorUserId: userId, action: 'privacy.retention_updated', targetType: 'privacy', metadata: input });
    return this.getRetention(organizationId);
  }

  // Deletes what is older than each organization's own limits, in batches so a big backlog never locks a table for long.
  async purgeExpired(): Promise<{ auditLogs: number; emailLogs: number; notifications: number }> {
    const total = { auditLogs: 0, emailLogs: 0, notifications: 0 };
    const policies = await db
      .select()
      .from(retentionPolicies)
      .where(or(isNotNull(retentionPolicies.auditLogDays), isNotNull(retentionPolicies.emailLogDays), isNotNull(retentionPolicies.notificationDays)));
    for (const p of policies) {
      if (p.auditLogDays)
        total.auditLogs += await this.deleteInBatches(
          sql`audit_logs`,
          sql`organization_id = ${p.organizationId} and created_at < now() - ${p.auditLogDays} * interval '1 day'`,
        );
      if (p.emailLogDays) {
        total.emailLogs += await this.deleteInBatches(
          sql`email_outbox`,
          sql`organization_id = ${p.organizationId} and status in ('sent', 'failed') and created_at < now() - ${p.emailLogDays} * interval '1 day'`,
        );
      }
      if (p.notificationDays) {
        total.notifications += await this.deleteInBatches(
          sql`notifications`,
          sql`organization_id = ${p.organizationId} and read_at is not null and created_at < now() - ${p.notificationDays} * interval '1 day'`,
        );
      }
    }
    return total;
  }

  private async deleteInBatches(table: SQL, where: SQL): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
      const result = await db.execute(sql`delete from ${table} where id in (select id from ${table} where ${where} limit ${PURGE_BATCH})`);
      const count = result.rowCount ?? 0;
      deleted += count;
      if (count < PURGE_BATCH) break;
    }
    return deleted;
  }
}

// Quote rows without the customer link's hash.
const quoteColumns = {
  id: quotes.id,
  quoteNumber: quotes.quoteNumber,
  status: quotes.status,
  contactId: quotes.contactId,
  companyId: quotes.companyId,
  dealId: quotes.dealId,
  customerName: quotes.customerName,
  currency: quotes.currency,
  subtotalMinor: quotes.subtotalMinor,
  discountMinor: quotes.discountMinor,
  taxMinor: quotes.taxMinor,
  totalMinor: quotes.totalMinor,
  validUntil: quotes.validUntil,
  notes: quotes.notes,
  terms: quotes.terms,
  sentAt: quotes.sentAt,
  respondedAt: quotes.respondedAt,
  respondedByName: quotes.respondedByName,
  responseNote: quotes.responseNote,
  createdAt: quotes.createdAt,
};

export const privacyService = new PrivacyService();
