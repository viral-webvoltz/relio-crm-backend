import { and, asc, count, desc, eq, exists, ilike, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import {
  campaignLinks,
  campaignRecipients,
  companies,
  contacts,
  contactTags,
  emailCampaigns,
  emailOutbox,
  emailSuppressions,
  organizations,
  tags,
  type CampaignAudience,
} from '@/database/schema/index.js';
import { likeContains } from '@/shared/utils/like.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import type { CampaignListQuery } from './campaigns.validation.js';

type NewCampaign = typeof emailCampaigns.$inferInsert;
type NewRecipient = typeof campaignRecipients.$inferInsert;
type NewOutbox = typeof emailOutbox.$inferInsert;

const campaignScope = (organizationId: string, id: string) => and(eq(emailCampaigns.organizationId, organizationId), eq(emailCampaigns.id, id));

function audienceFilter(organizationId: string, audience: CampaignAudience) {
  const live = and(eq(contacts.organizationId, organizationId), isNull(contacts.deletedAt));
  switch (audience.type) {
    case 'all':
      return live;
    case 'company':
      return and(live, eq(contacts.companyId, audience.companyId));
    case 'contacts':
      return and(live, inArray(contacts.id, audience.contactIds));
    case 'tag':
      return and(
        live,
        exists(
          db
            .select({ one: sql`1` })
            .from(contactTags)
            .where(and(eq(contactTags.contactId, contacts.id), eq(contactTags.tagId, audience.tagId))),
        ),
      );
  }
}

const suppressed = (organizationId: string) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.organizationId, organizationId), eq(emailSuppressions.email, sql`lower(${contacts.email})`))),
  );

class CampaignsRepository {
  async list({ organizationId, query: { page, limit, search, status, sort, dir } }: { organizationId: string; query: CampaignListQuery }) {
    const where = and(
      eq(emailCampaigns.organizationId, organizationId),
      status ? eq(emailCampaigns.status, status) : undefined,
      search ? ilike(emailCampaigns.name, likeContains(search)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(emailCampaigns)
        .where(where)
        .orderBy(
          ...orderByClause(
            { name: emailCampaigns.name, status: emailCampaigns.status, createdAt: emailCampaigns.createdAt, launchedAt: emailCampaigns.launchedAt },
            { sort, dir },
            [desc(emailCampaigns.createdAt)],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(emailCampaigns).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(emailCampaigns).where(campaignScope(organizationId, id));
    return row;
  }

  async lockById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(emailCampaigns).where(campaignScope(organizationId, id)).for('update');
    return row;
  }

  async insert(values: NewCampaign, executor: DbExecutor = db) {
    const [row] = await executor.insert(emailCampaigns).values(values).returning();
    return row!;
  }

  async update({ id, set }: { id: string; set: Partial<NewCampaign> }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(emailCampaigns)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(emailCampaigns.id, id))
      .returning();
    return row!;
  }

  async remove({ id }: { id: string }, executor: DbExecutor = db) {
    await executor.delete(emailCampaigns).where(eq(emailCampaigns.id, id));
  }

  tagExists = async ({ organizationId, id }: { organizationId: string; id: string }) =>
    Boolean(
      (
        await db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.organizationId, organizationId), eq(tags.id, id)))
      )[0],
    );

  companyExists = async ({ organizationId, id }: { organizationId: string; id: string }) =>
    Boolean(
      (
        await db
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.organizationId, organizationId), eq(companies.id, id), isNull(companies.deletedAt)))
      )[0],
    );

  // Everyone the audience matches, and the subset with an address that is not suppressed (capped, so a huge audience cannot load into memory).
  async audience({ organizationId, audience, limit }: { organizationId: string; audience: CampaignAudience; limit: number }, executor: DbExecutor = db) {
    const matching = audienceFilter(organizationId, audience);
    const [[matched], eligible] = await Promise.all([
      executor.select({ value: count() }).from(contacts).where(matching),
      executor
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
        .from(contacts)
        .where(and(matching, isNotNull(contacts.email), ne(contacts.email, ''), sql`not ${suppressed(organizationId)}`))
        .orderBy(asc(contacts.createdAt), asc(contacts.id))
        .limit(limit),
    ]);
    return { matched: matched?.value ?? 0, eligible };
  }

  async insertLinks(values: { campaignId: string; url: string }[], executor: DbExecutor = db) {
    if (values.length === 0) return [];
    return executor.insert(campaignLinks).values(values).returning();
  }

  async insertOutbox(values: NewOutbox[], executor: DbExecutor = db) {
    await executor.insert(emailOutbox).values(values);
  }

  async insertRecipients(values: NewRecipient[], executor: DbExecutor = db) {
    await executor.insert(campaignRecipients).values(values);
  }

  async stats({ campaignId }: { campaignId: string }) {
    const result = await db.execute<{
      total: number;
      sent: number;
      pending: number;
      failed: number;
      opened: number;
      clicked: number;
      unsubscribed: number;
    }>(sql`
      select count(*)::int as total,
             (count(*) filter (where o.status = 'sent'))::int as sent,
             (count(*) filter (where o.status in ('queued', 'sending')))::int as pending,
             (count(*) filter (where o.status = 'failed'))::int as failed,
             count(r.opened_at)::int as opened,
             count(r.clicked_at)::int as clicked,
             count(r.unsubscribed_at)::int as unsubscribed
      from campaign_recipients r left join email_outbox o on o.id = r.outbox_id
      where r.campaign_id = ${campaignId}`);
    return result.rows[0]!;
  }

  async listRecipients({ campaignId, page, limit }: { campaignId: string; page: number; limit: number }) {
    const where = eq(campaignRecipients.campaignId, campaignId);
    const [rows, [total]] = await Promise.all([
      db
        .select({
          id: campaignRecipients.id,
          contactId: campaignRecipients.contactId,
          email: campaignRecipients.email,
          deliveryStatus: emailOutbox.status,
          deliveryError: emailOutbox.lastError,
          sentAt: emailOutbox.sentAt,
          openedAt: campaignRecipients.openedAt,
          clickedAt: campaignRecipients.clickedAt,
          unsubscribedAt: campaignRecipients.unsubscribedAt,
        })
        .from(campaignRecipients)
        .leftJoin(emailOutbox, eq(emailOutbox.id, campaignRecipients.outboxId))
        .where(where)
        .orderBy(asc(campaignRecipients.email))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(campaignRecipients).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  // Stops mail that has not gone out yet; returns how many were held back.
  async cancelQueued({ campaignId }: { campaignId: string }, executor: DbExecutor = db) {
    const rows = await executor
      .update(emailOutbox)
      .set({ status: 'failed', lastError: 'Campaign cancelled' })
      .where(
        and(
          eq(emailOutbox.status, 'queued'),
          inArray(
            emailOutbox.id,
            executor
              .select({ id: campaignRecipients.outboxId })
              .from(campaignRecipients)
              .where(and(eq(campaignRecipients.campaignId, campaignId), isNotNull(campaignRecipients.outboxId))),
          ),
        ),
      )
      .returning({ id: emailOutbox.id });
    return rows.length;
  }

  // An unsubscribe also stops this address's campaign mail that is still waiting in the outbox.
  async cancelQueuedFor({ organizationId, email }: { organizationId: string; email: string }) {
    await db
      .update(emailOutbox)
      .set({ status: 'failed', lastError: 'Recipient unsubscribed' })
      .where(
        and(
          eq(emailOutbox.organizationId, organizationId),
          eq(emailOutbox.kind, 'campaign'),
          eq(emailOutbox.status, 'queued'),
          sql`lower(${emailOutbox.toEmail}) = ${email}`,
        ),
      );
  }

  async dueScheduled({ now, limit }: { now: Date; limit: number }) {
    return db
      .select({ id: emailCampaigns.id, organizationId: emailCampaigns.organizationId, createdBy: emailCampaigns.createdBy })
      .from(emailCampaigns)
      .where(and(eq(emailCampaigns.status, 'scheduled'), lte(emailCampaigns.scheduledAt, now)))
      .orderBy(asc(emailCampaigns.scheduledAt))
      .limit(limit);
  }

  // ---- suppressions ----

  async listSuppressions({ organizationId, page, limit }: { organizationId: string; page: number; limit: number }) {
    const where = eq(emailSuppressions.organizationId, organizationId);
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(emailSuppressions)
        .where(where)
        .orderBy(desc(emailSuppressions.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(emailSuppressions).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async suppress({ organizationId, email, reason }: { organizationId: string; email: string; reason: 'unsubscribed' | 'manual' }) {
    await db.insert(emailSuppressions).values({ organizationId, email: email.toLowerCase(), reason }).onConflictDoNothing();
  }

  async removeSuppression({ organizationId, id }: { organizationId: string; id: string }) {
    const rows = await db
      .delete(emailSuppressions)
      .where(and(eq(emailSuppressions.organizationId, organizationId), eq(emailSuppressions.id, id)))
      .returning({ id: emailSuppressions.id });
    return rows.length > 0;
  }

  // ---- the customer side: everything is looked up by the recipient token ----

  async findRecipient({ token }: { token: string }) {
    const [row] = await db
      .select({
        id: campaignRecipients.id,
        organizationId: campaignRecipients.organizationId,
        campaignId: campaignRecipients.campaignId,
        email: campaignRecipients.email,
        unsubscribedAt: campaignRecipients.unsubscribedAt,
        organizationName: organizations.name,
      })
      .from(campaignRecipients)
      .innerJoin(organizations, eq(organizations.id, campaignRecipients.organizationId))
      .where(eq(campaignRecipients.token, token));
    return row;
  }

  async markOpened({ token }: { token: string }) {
    await db
      .update(campaignRecipients)
      .set({ openedAt: sql`coalesce(${campaignRecipients.openedAt}, now())` })
      .where(and(eq(campaignRecipients.token, token), isNull(campaignRecipients.openedAt)));
  }

  // The link must belong to the same campaign as the recipient, so a token cannot be used to probe other campaigns' links.
  async clickTarget({ linkId, token }: { linkId: string; token: string }) {
    const [row] = await db
      .select({ url: campaignLinks.url, recipientId: campaignRecipients.id })
      .from(campaignLinks)
      .innerJoin(campaignRecipients, eq(campaignRecipients.campaignId, campaignLinks.campaignId))
      .where(and(eq(campaignLinks.id, linkId), eq(campaignRecipients.token, token)));
    if (!row) return undefined;
    await db
      .update(campaignRecipients)
      .set({ clickedAt: sql`coalesce(${campaignRecipients.clickedAt}, now())`, openedAt: sql`coalesce(${campaignRecipients.openedAt}, now())` })
      .where(eq(campaignRecipients.id, row.recipientId));
    return row.url;
  }

  async markUnsubscribed({ id }: { id: string }) {
    await db
      .update(campaignRecipients)
      .set({ unsubscribedAt: sql`coalesce(${campaignRecipients.unsubscribedAt}, now())` })
      .where(eq(campaignRecipients.id, id));
  }
}

export const campaignsRepository = new CampaignsRepository();
