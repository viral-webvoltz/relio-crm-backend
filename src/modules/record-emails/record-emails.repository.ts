import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { activities, contacts, leads, users } from '@/database/schema/index.js';
import { emailOutbox } from '@/database/schema/mail.js';

export type EmailRecordType = 'lead' | 'contact';

export type EmailRecord = { id: string; email: string | null; name: string; status: string | null; assignedTo: string | null };

const fullName = (r: { firstName: string; lastName: string | null }) => [r.firstName, r.lastName].filter(Boolean).join(' ');

class RecordEmailsRepository {
  async findRecord({ organizationId, type, id }: { organizationId: string; type: EmailRecordType; id: string }): Promise<EmailRecord | undefined> {
    if (type === 'lead') {
      const [r] = await db.select().from(leads).where(and(eq(leads.organizationId, organizationId), eq(leads.id, id), isNull(leads.deletedAt)));
      return r && { id: r.id, email: r.email, name: fullName(r), status: r.status, assignedTo: r.assignedTo };
    }
    const [r] = await db.select().from(contacts).where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNull(contacts.deletedAt)));
    return r && { id: r.id, email: r.email, name: fullName(r), status: null, assignedTo: null };
  }

  async insertEmail(values: typeof activities.$inferInsert) {
    const [row] = await db.insert(activities).values(values).onConflictDoNothing().returning();
    return row; // undefined when the same Message-ID was already stored (a re-delivered inbound email)
  }

  async deleteActivity(id: string) {
    await db.delete(activities).where(eq(activities.id, id));
  }

  // Newest Message-ID in the record's conversation, so the next email threads under it.
  async lastMessageId({ organizationId, type, id }: { organizationId: string; type: EmailRecordType; id: string }) {
    const [row] = await db
      .select({ messageId: activities.messageId })
      .from(activities)
      .where(and(eq(activities.organizationId, organizationId), eq(activities.relatedType, type), eq(activities.relatedId, id), isNotNull(activities.messageId)))
      .orderBy(desc(activities.occurredAt))
      .limit(1);
    return row?.messageId ?? undefined;
  }

  async findOutboundById(id: string) {
    const [row] = await db.select().from(activities).where(and(eq(activities.id, id), eq(activities.direction, 'outbound')));
    return row;
  }

  async findOutboundByThread({ organizationId, threadId }: { organizationId: string; threadId: string }) {
    const [row] = await db
      .select()
      .from(activities)
      .where(and(eq(activities.organizationId, organizationId), eq(activities.threadId, threadId), eq(activities.direction, 'outbound')))
      .orderBy(desc(activities.occurredAt))
      .limit(1);
    return row;
  }

  // Last resort for a reply nothing else could place: the newest email we sent to this address with this subject (case-insensitive).
  async findLatestOutboundTo({ organizationId, email, subject }: { organizationId: string; email: string; subject: string }) {
    const [row] = await db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.type, 'email'),
          eq(activities.direction, 'outbound'),
          sql`lower(${activities.emailAddress}) = ${email.toLowerCase()}`,
          sql`lower(${activities.subject}) = ${subject.toLowerCase()}`,
        ),
      )
      .orderBy(desc(activities.occurredAt))
      .limit(1);
    return row;
  }

  // ids are bare Message-IDs (no angle brackets).
  async findOutboundByMessageIds(ids: string[]) {
    const [row] = await db
      .select()
      .from(activities)
      .where(and(inArray(activities.messageId, ids), eq(activities.direction, 'outbound')))
      .limit(1);
    return row;
  }

  // Moves a lead along only if it is still in one of the expected states, so a manual change or a converted lead is never overwritten.
  async advanceLead({ organizationId, id, from, to }: { organizationId: string; id: string; from: string[]; to: string }) {
    const rows = await db
      .update(leads)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(leads.organizationId, organizationId), eq(leads.id, id), isNull(leads.deletedAt), inArray(leads.status, from)))
      .returning({ id: leads.id });
    return rows.length > 0;
  }

  // The conversation, oldest first, with what happened to each sent email (queued | sending | sent | failed).
  async listEmails({ organizationId, type, id }: { organizationId: string; type: EmailRecordType; id: string }) {
    return db
      .select({
        id: activities.id,
        direction: activities.direction,
        subject: activities.subject,
        body: activities.body,
        emailAddress: activities.emailAddress,
        messageId: activities.messageId, // bare, no angle brackets; a reply points at it with In-Reply-To
        occurredAt: activities.occurredAt,
        sentBy: users.fullName,
        deliveryStatus: emailOutbox.status,
        deliveryError: emailOutbox.lastError,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.createdBy))
      .leftJoin(emailOutbox, and(eq(emailOutbox.organizationId, activities.organizationId), eq(emailOutbox.messageId, sql`'<' || ${activities.messageId} || '>'`)))
      .where(and(eq(activities.organizationId, organizationId), eq(activities.relatedType, type), eq(activities.relatedId, id), eq(activities.type, 'email')))
      .orderBy(asc(activities.occurredAt));
  }
}

export const recordEmailsRepository = new RecordEmailsRepository();
