import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { contacts } from './crm.js';
import { organizations, users } from './identity.js';
import { emailOutbox } from './mail.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export type CampaignAudience =
  { type: 'all' } | { type: 'tag'; tagId: string } | { type: 'company'; companyId: string } | { type: 'contacts'; contactIds: string[] };

export const emailCampaigns = pgTable(
  'email_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),
    audience: jsonb('audience').$type<CampaignAudience>().notNull(),
    status: text('status').notNull().default('draft'), // draft | scheduled | sent | cancelled
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    skippedCount: integer('skipped_count').notNull().default(0), // matched the audience but had no usable address, or had unsubscribed
    lastError: text('last_error'), // why a scheduled launch could not run
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('email_campaigns_org_status_idx').on(t.organizationId, t.status, t.createdAt.desc()),
    index('email_campaigns_due_idx').on(t.status, t.scheduledAt),
  ],
);

// One row per person a campaign was sent to, fixed at launch. The token identifies the recipient in the open pixel, the click links and
// the unsubscribe link; it carries no other authority.
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => emailCampaigns.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    token: text('token').notNull(),
    outboxId: uuid('outbox_id').references(() => emailOutbox.id, { onDelete: 'set null' }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('campaign_recipients_token_uq').on(t.token), uniqueIndex('campaign_recipients_campaign_email_uq').on(t.campaignId, t.email)],
);

// Click targets are stored, never taken from the request, so the redirect cannot be abused as an open redirect.
export const campaignLinks = pgTable(
  'campaign_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => emailCampaigns.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
  },
  (t) => [index('campaign_links_campaign_idx').on(t.campaignId)],
);

// Addresses that must not get marketing email. Stored lower-cased; transactional mail (invoices, tickets) ignores this list.
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    email: text('email').notNull(),
    reason: text('reason').notNull(), // unsubscribed | manual
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('email_suppressions_org_email_uq').on(t.organizationId, t.email)],
);
