import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { contactTags, tags } from '@/database/schema/collaboration.js';
import { contacts } from '@/database/schema/crm.js';
import { getOffset } from '@/shared/pagination/index.js';
import type { TagContactsQuery } from './tags.validation.js';

const own = (organizationId: string) => eq(tags.organizationId, organizationId);
const liveContact = (organizationId: string) => and(eq(contacts.organizationId, organizationId), isNull(contacts.deletedAt));

class TagsRepository {
  async listWithCounts(organizationId: string, executor: DbExecutor = db) {
    const rows = await executor
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        createdAt: tags.createdAt,
        usageCount: sql<number>`count(${contacts.id})::int`,
      })
      .from(tags)
      .leftJoin(contactTags, eq(contactTags.tagId, tags.id))
      .leftJoin(contacts, and(eq(contacts.id, contactTags.contactId), isNull(contacts.deletedAt)))
      .where(own(organizationId))
      .groupBy(tags.id)
      .orderBy(sql`lower(${tags.name})`);
    return rows;
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select()
      .from(tags)
      .where(and(own(organizationId), eq(tags.id, id)));
    return row;
  }

  async findByName({ organizationId, name }: { organizationId: string; name: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select()
      .from(tags)
      .where(and(own(organizationId), sql`lower(${tags.name}) = lower(${name})`));
    return row;
  }

  async insert(values: typeof tags.$inferInsert, executor: DbExecutor = db) {
    const [row] = await executor.insert(tags).values(values).returning();
    return row;
  }

  async update({ organizationId, id, changes }: { organizationId: string; id: string; changes: { name?: string; color?: string } }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(tags)
      .set(changes)
      .where(and(own(organizationId), eq(tags.id, id)))
      .returning();
    return row;
  }

  // contact_tags rows go with the tag via ON DELETE CASCADE.
  async remove({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const rows = await executor
      .delete(tags)
      .where(and(own(organizationId), eq(tags.id, id)))
      .returning({ id: tags.id });
    return rows.length > 0;
  }

  async contactExists({ organizationId, contactId }: { organizationId: string; contactId: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(liveContact(organizationId), eq(contacts.id, contactId)));
    return Boolean(row);
  }

  async countExisting({ organizationId, ids }: { organizationId: string; ids: string[] }, executor: DbExecutor = db) {
    if (ids.length === 0) return 0;
    const [row] = await executor
      .select({ value: count() })
      .from(tags)
      .where(and(own(organizationId), inArray(tags.id, ids)));
    return row?.value ?? 0;
  }

  async replaceContactTags({ organizationId, contactId, tagIds }: { organizationId: string; contactId: string; tagIds: string[] }, executor: DbExecutor = db) {
    await executor.delete(contactTags).where(and(eq(contactTags.organizationId, organizationId), eq(contactTags.contactId, contactId)));
    if (tagIds.length > 0) {
      await executor.insert(contactTags).values(tagIds.map((tagId) => ({ organizationId, contactId, tagId })));
    }
  }

  listForContact({ organizationId, contactId }: { organizationId: string; contactId: string }, executor: DbExecutor = db) {
    return executor
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(and(eq(contactTags.organizationId, organizationId), eq(contactTags.contactId, contactId)))
      .orderBy(sql`lower(${tags.name})`);
  }

  async listContacts({ organizationId, tagId, query }: { organizationId: string; tagId: string; query: TagContactsQuery }, executor: DbExecutor = db) {
    const where = and(liveContact(organizationId), eq(contactTags.organizationId, organizationId), eq(contactTags.tagId, tagId));
    const [rows, [total]] = await Promise.all([
      executor
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
        .from(contactTags)
        .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
        .where(where)
        .orderBy(asc(contacts.firstName), asc(contacts.id))
        .limit(query.limit)
        .offset(getOffset(query)),
      executor.select({ value: count() }).from(contactTags).innerJoin(contacts, eq(contacts.id, contactTags.contactId)).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }
}

export const tagsRepository = new TagsRepository();
