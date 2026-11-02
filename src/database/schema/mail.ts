import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './identity.js';

// Outbox: rows are written next to the business change and sent by the in-process mailer.
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // invoice | ticket_reply | ...
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),
    status: text('status').notNull().default('queued'), // queued | sending | sent | failed
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),
    messageId: text('message_id'), // RFC 5322 Message-ID incl. angle brackets, so replies can be matched back
    replyTo: text('reply_to'),
    inReplyTo: text('in_reply_to'),
    headers: jsonb('headers').$type<Record<string, string>>(), // extra headers, e.g. List-Unsubscribe on campaign mail
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('email_outbox_due_idx').on(t.status, t.nextAttemptAt), index('email_outbox_message_id_idx').on(t.messageId)],
);

// The Gmail accounts an organization can send email from, through the Gmail API with an OAuth refresh token. The client secret and refresh
// token are stored sealed (AES-GCM, see auth/secret-box), never in the clear. One account per organization is active: the one mail goes out
// from. With no active account, the server-wide SMTP settings apply.
export const organizationMailSettings = pgTable(
  'organization_mail_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fromEmail: text('from_email').notNull(), // the Gmail account that sends, lower-cased
    fromName: text('from_name'),
    clientId: text('client_id').notNull(),
    clientSecretSealed: text('client_secret_sealed').notNull(),
    refreshTokenSealed: text('refresh_token_sealed').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }), // when the inbox was last read for replies
    syncError: text('sync_error'), // why reading replies is not working, in words the person can act on
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('organization_mail_settings_org_email_uq').on(t.organizationId, t.fromEmail),
    uniqueIndex('organization_mail_settings_active_uq')
      .on(t.organizationId)
      .where(sql`${t.isActive}`),
  ],
);
