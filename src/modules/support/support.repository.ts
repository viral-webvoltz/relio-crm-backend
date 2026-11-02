import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db, type DbExecutor } from '@/config/database.js';
import { contacts, supportTickets, ticketMessages, ticketSequences, users } from '@/database/schema/index.js';
import { emailOutbox } from '@/database/schema/mail.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { TicketListQuery } from './support.validation.js';

type NewTicket = typeof supportTickets.$inferInsert;
type NewMessage = typeof ticketMessages.$inferInsert;
type TicketChanges = Partial<typeof supportTickets.$inferInsert>;
// The customer's own scope, from the server-side session.
interface OwnScope {
  organizationId: string;
  contactId: string;
}

const ticketScope = (organizationId: string, id: string) => and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.id, id));
const isBreachedSql = sql<boolean>`${supportTickets.status} = 'open' and ${supportTickets.slaDueAt} < now()`;

const own = ({ organizationId, contactId }: OwnScope, id?: string) =>
  and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.contactId, contactId), id ? eq(supportTickets.id, id) : undefined);

// Customer-facing columns are named explicitly: assignee, SLA, priority handling and internal notes are never selected, so they cannot leak.
const portalTicketColumns = {
  id: supportTickets.id,
  ticketNumber: supportTickets.ticketNumber,
  subject: supportTickets.subject,
  status: supportTickets.status,
  createdAt: supportTickets.createdAt,
  updatedAt: supportTickets.updatedAt,
};

// 80 random bits, lowercase hex so it survives mail systems that lowercase the address.
const newReplyToken = () => randomBytes(10).toString('hex');

class SupportRepository {
  // Same gap-free counter pattern as orders and invoices.
  async nextTicketNumber(organizationId: string, executor: DbExecutor = db) {
    const [sequence] = await executor
      .insert(ticketSequences)
      .values({ organizationId, lastNumber: 1 })
      .onConflictDoUpdate({ target: ticketSequences.organizationId, set: { lastNumber: sql`${ticketSequences.lastNumber} + 1` } })
      .returning();
    return sequence!.lastNumber;
  }

  async findActiveUserId(organizationId: string, id: string) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, id), eq(users.isActive, true)));
    return row;
  }

  async findContactName(organizationId: string, id: string, executor: DbExecutor = db) {
    const [contact] = await executor
      .select({ firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNull(contacts.deletedAt)));
    return contact;
  }

  async insertTicket(values: NewTicket, executor: DbExecutor = db) {
    const [ticket] = await executor
      .insert(supportTickets)
      .values({ replyToken: newReplyToken(), ...values })
      .returning();
    return ticket!;
  }

  async insertMessage(values: NewMessage, executor: DbExecutor = db) {
    const [message] = await executor.insert(ticketMessages).values(values).returning();
    return message!;
  }

  async list(organizationId: string, userId: string, { page, limit, search, status, priority, assignee, sla }: TicketListQuery) {
    const isNumber = search && /^#?\d+$/.test(search);
    const statusFilter = status === 'active' ? inArray(supportTickets.status, ['open', 'pending']) : status ? eq(supportTickets.status, status) : undefined;
    const assigneeFilter =
      assignee === 'unassigned'
        ? sql`${supportTickets.assignedTo} is null`
        : assignee
          ? eq(supportTickets.assignedTo, assignee === 'me' ? userId : assignee)
          : undefined;
    const searchFilter = !search
      ? undefined
      : isNumber
        ? eq(supportTickets.ticketNumber, Number(search.replace('#', '')))
        : or(ilike(supportTickets.subject, likeContains(search)), ilike(supportTickets.customerName, likeContains(search)));
    const where = and(
      eq(supportTickets.organizationId, organizationId),
      statusFilter,
      assigneeFilter,
      searchFilter,
      priority ? eq(supportTickets.priority, priority) : undefined,
      sla ? isBreachedSql : undefined,
    );

    const [rows, [total]] = await Promise.all([
      db
        .select({ ticket: supportTickets, assigneeName: users.fullName, isSlaBreached: isBreachedSql })
        .from(supportTickets)
        .leftJoin(users, eq(users.id, supportTickets.assignedTo))
        .where(where)
        .orderBy(desc(supportTickets.ticketNumber))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(supportTickets).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findDetail(organizationId: string, id: string) {
    const [row] = await db
      .select({ ticket: supportTickets, assigneeName: users.fullName, isSlaBreached: isBreachedSql })
      .from(supportTickets)
      .leftJoin(users, eq(users.id, supportTickets.assignedTo))
      .where(ticketScope(organizationId, id));
    return row;
  }

  // Staff see everything, internal notes included; author names are resolved for display.
  listMessagesWithAuthors(ticketId: string) {
    return db
      .select({ message: ticketMessages, staffName: users.fullName, customerFirst: contacts.firstName, customerLast: contacts.lastName })
      .from(ticketMessages)
      .leftJoin(users, eq(users.id, ticketMessages.authorUserId))
      .leftJoin(contacts, eq(contacts.id, ticketMessages.authorContactId))
      .where(eq(ticketMessages.ticketId, ticketId))
      .orderBy(asc(ticketMessages.createdAt));
  }

  async lockTicket(organizationId: string, id: string, executor: DbExecutor = db) {
    const [ticket] = await executor.select().from(supportTickets).where(ticketScope(organizationId, id)).for('update');
    return ticket;
  }

  async updateTicket(id: string, changes: TicketChanges, executor: DbExecutor = db) {
    const [updated] = await executor.update(supportTickets).set(changes).where(eq(supportTickets.id, id)).returning();
    return updated!;
  }

  // ---- Email threading ----

  // Tickets created before reply tokens existed get one the first time an email goes out.
  async ensureReplyToken(organizationId: string, ticketId: string) {
    const [updated] = await db
      .update(supportTickets)
      .set({ replyToken: newReplyToken() })
      .where(and(ticketScope(organizationId, ticketId), isNull(supportTickets.replyToken)))
      .returning({ token: supportTickets.replyToken });
    if (updated?.token) return updated.token;
    const [row] = await db.select({ token: supportTickets.replyToken }).from(supportTickets).where(ticketScope(organizationId, ticketId));
    if (!row?.token) throw new Error('Ticket has no reply token');
    return row.token;
  }

  // Newest known Message-ID of the conversation (inbound or outbound), with angle brackets.
  async lastMessageId(organizationId: string, ticketId: string) {
    const [[inbound], [outbound]] = await Promise.all([
      db
        .select({ id: ticketMessages.emailMessageId, at: ticketMessages.createdAt })
        .from(ticketMessages)
        .where(and(eq(ticketMessages.organizationId, organizationId), eq(ticketMessages.ticketId, ticketId), sql`${ticketMessages.emailMessageId} is not null`))
        .orderBy(desc(ticketMessages.createdAt))
        .limit(1),
      db
        .select({ id: emailOutbox.messageId, at: emailOutbox.createdAt })
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.organizationId, organizationId),
            eq(emailOutbox.relatedType, 'ticket'),
            eq(emailOutbox.relatedId, ticketId),
            sql`${emailOutbox.messageId} is not null`,
          ),
        )
        .orderBy(desc(emailOutbox.createdAt))
        .limit(1),
    ]);
    if (inbound?.id && (!outbound?.id || !outbound.at || inbound.at > outbound.at)) return `<${inbound.id}>`;
    return outbound?.id ?? undefined;
  }

  // Inbound lookups cross organizations on purpose: the secret-authenticated mail endpoint has no session.
  async findTicketByReplyToken(token: string) {
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.replyToken, token));
    return ticket;
  }

  // ids are bare Message-IDs (no angle brackets).
  async findTicketByMessageIds(ids: string[]) {
    if (!ids.length) return undefined;
    const [fromMessage] = await db
      .select({ ticket: supportTickets })
      .from(ticketMessages)
      .innerJoin(supportTickets, eq(supportTickets.id, ticketMessages.ticketId))
      .where(inArray(ticketMessages.emailMessageId, ids))
      .limit(1);
    if (fromMessage) return fromMessage.ticket;
    const [fromOutbox] = await db
      .select({ ticket: supportTickets })
      .from(emailOutbox)
      .innerJoin(supportTickets, and(eq(supportTickets.id, emailOutbox.relatedId), eq(supportTickets.organizationId, emailOutbox.organizationId)))
      .where(
        and(
          eq(emailOutbox.relatedType, 'ticket'),
          inArray(
            emailOutbox.messageId,
            ids.map((id) => `<${id}>`),
          ),
        ),
      )
      .limit(1);
    return fromOutbox?.ticket;
  }

  // At most 2 rows: more than one means the sender is ambiguous across organizations.
  findContactsByEmail(email: string, organizationId?: string) {
    return db
      .select({ id: contacts.id, organizationId: contacts.organizationId, email: contacts.email })
      .from(contacts)
      .where(
        and(sql`lower(${contacts.email}) = ${email}`, isNull(contacts.deletedAt), organizationId ? eq(contacts.organizationId, organizationId) : undefined),
      )
      .limit(2);
  }

  async findContactEmail(organizationId: string, id: string) {
    const [row] = await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNull(contacts.deletedAt)));
    return row?.email ?? undefined;
  }

  messageIdExists(organizationId: string, emailMessageId: string) {
    return db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.organizationId, organizationId), eq(ticketMessages.emailMessageId, emailMessageId)))
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  // undefined = this Message-ID was already stored (redelivery).
  async insertInboundMessage(values: NewMessage, executor: DbExecutor = db) {
    const [message] = await executor.insert(ticketMessages).values(values).onConflictDoNothing().returning();
    return message;
  }

  // ---- Customer portal ----

  async listOwn(customer: OwnScope, { page, limit }: ListQuery) {
    const [rows, [total]] = await Promise.all([
      db
        .select(portalTicketColumns)
        .from(supportTickets)
        .where(own(customer))
        .orderBy(desc(supportTickets.ticketNumber))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(supportTickets).where(own(customer)),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findOwn(customer: OwnScope, id: string) {
    const [ticket] = await db.select(portalTicketColumns).from(supportTickets).where(own(customer, id));
    return ticket;
  }

  // isInternal = false is the visibility rule; it is part of the query, not something filtered afterwards.
  listPublicMessages(ticketId: string) {
    return db
      .select({ id: ticketMessages.id, authorType: ticketMessages.authorType, body: ticketMessages.body, createdAt: ticketMessages.createdAt })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.isInternal, false)))
      .orderBy(asc(ticketMessages.createdAt));
  }

  async countOwnOpen(customer: OwnScope, executor: DbExecutor = db) {
    const [open] = await executor
      .select({ value: count() })
      .from(supportTickets)
      .where(and(own(customer), inArray(supportTickets.status, ['open', 'pending'])));
    return open?.value ?? 0;
  }

  async insertPortalTicket(values: NewTicket, executor: DbExecutor = db) {
    const [ticket] = await executor
      .insert(supportTickets)
      .values({ replyToken: newReplyToken(), ...values })
      .returning(portalTicketColumns);
    return ticket!;
  }

  async lockOwnTicket(customer: OwnScope, id: string, executor: DbExecutor = db) {
    const [ticket] = await executor.select().from(supportTickets).where(own(customer, id)).for('update');
    return ticket;
  }
}

export const supportRepository = new SupportRepository();
