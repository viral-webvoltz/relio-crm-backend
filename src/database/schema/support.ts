import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { contacts } from './crm.js';
import { organizations, users } from './identity.js';

const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

// One counter row per organization; an atomic upsert hands out gap-free, unique ticket numbers.
export const ticketSequences = pgTable('ticket_sequences', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  lastNumber: integer('last_number').notNull(),
});

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    ticketNumber: integer('ticket_number').notNull(),
    subject: text('subject').notNull(),
    status: text('status').notNull().default('open'), // open | pending (waiting on the customer) | resolved | closed
    priority: text('priority').notNull().default('medium'), // low | medium | high | urgent
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    customerName: text('customer_name'), // snapshot, so the ticket still reads correctly if the contact is deleted
    source: text('source').notNull().default('staff'), // staff | portal | email
    replyToken: text('reply_token'), // unguessable token for the reply-to plus-address; null on old rows until lazily backfilled
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }).notNull(), // target resolution time, from creation + priority
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // First-reply target and when it was met (the first customer-visible staff reply). Null target = the ticket predates first-response tracking.
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
    firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
    // Set once the escalation scan has raised the matching alert; cleared when the deadline moves, so the new deadline can alert again.
    slaWarnedAt: timestamp('sla_warned_at', { withTimezone: true }),
    slaBreachNotifiedAt: timestamp('sla_breach_notified_at', { withTimezone: true }),
    firstResponseBreachNotifiedAt: timestamp('first_response_breach_notified_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('support_tickets_reply_token_uq').on(t.replyToken),
    uniqueIndex('support_tickets_org_number_uq').on(t.organizationId, t.ticketNumber),
    index('support_tickets_org_status_idx').on(t.organizationId, t.status, t.priority),
    index('support_tickets_contact_idx').on(t.contactId),
    index('support_tickets_org_contact_idx').on(t.organizationId, t.contactId, t.ticketNumber.desc()), // portal: a customer's own tickets
    index('support_tickets_org_assignee_status_idx').on(t.organizationId, t.assignedTo, t.status),
    index('support_tickets_open_sla_idx')
      .on(t.slaDueAt)
      .where(sql`${t.status} = 'open'`), // what the escalation scan reads
  ],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: orgId(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    authorType: text('author_type').notNull(), // staff | customer
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorContactId: uuid('author_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    emailMessageId: text('email_message_id'), // inbound Message-ID without angle brackets; makes redelivery idempotent
    // Internal notes are for staff only. The database itself refuses an internal customer message, and the
    // portal queries filter on this column, so a note can never be shown to a customer.
    isInternal: boolean('is_internal').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ticket_messages_org_email_message_uq')
      .on(t.organizationId, t.emailMessageId)
      .where(sql`${t.emailMessageId} is not null`),
    index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt),
    check('ticket_messages_customer_not_internal', sql`not (${t.authorType} = 'customer' and ${t.isInternal})`),
  ],
);
