import { and, count, desc, eq, ilike, isNotNull, isNull, or } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { companies, contacts } from '@/database/schema/index.js';
import { restoreSet, softDeleteSet } from '@/database/soft-delete.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import { cfFilterConditions, mergeCustomFields } from '@/modules/custom-fields/custom-fields.validate.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { ContactListQuery, CreateContactInput, UpdateContactInput } from './contacts.validation.js';

const scope = (organizationId: string, id: string) => and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNull(contacts.deletedAt));
const trashScope = (organizationId: string, id: string) => and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNotNull(contacts.deletedAt));

class ContactsRepository {
  async list({ organizationId, query }: { organizationId: string; query: ContactListQuery }, executor: DbExecutor = db) {
    const { page, limit, search, sort, dir, cf } = query;
    const term = search ? likeContains(search) : '';
    const where = and(
      eq(contacts.organizationId, organizationId),
      isNull(contacts.deletedAt),
      ...cfFilterConditions(contacts.customFields, cf),
      search ? or(ilike(contacts.firstName, term), ilike(contacts.lastName, term), ilike(contacts.email, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select({ contact: contacts, companyName: companies.name })
        .from(contacts)
        .leftJoin(companies, and(eq(contacts.companyId, companies.id), isNull(companies.deletedAt)))
        .where(where)
        .orderBy(
          ...orderByClause({ name: contacts.firstName, email: contacts.email, company: companies.name, createdAt: contacts.createdAt }, { sort, dir }, [
            desc(contacts.createdAt),
          ]),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(contacts).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.contact, companyName: r.companyName })), total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(contacts).where(scope(organizationId, id));
    return row ?? null;
  }

  async findByEmail({ organizationId, email }: { organizationId: string; email: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.email, email), isNull(contacts.deletedAt)));
    return row ?? null;
  }

  async companyExists({ organizationId, companyId }: { organizationId: string; companyId: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.id, companyId), isNull(companies.deletedAt)));
    return Boolean(row);
  }

  async create({ organizationId, input }: { organizationId: string; input: CreateContactInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .insert(contacts)
      .values({ ...input, organizationId })
      .returning();
    return row!;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateContactInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(contacts)
      .set({ ...input, customFields: input.customFields ? mergeCustomFields(contacts.customFields, input.customFields) : undefined, updatedAt: new Date() })
      .where(scope(organizationId, id))
      .returning();
    return row ?? null;
  }

  async remove({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }, executor: DbExecutor = db) {
    const deleted = await executor.update(contacts).set(softDeleteSet(userId)).where(scope(organizationId, id)).returning({ id: contacts.id });
    return deleted.length > 0;
  }

  async listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }, executor: DbExecutor = db) {
    const { page, limit, search } = query;
    const term = search ? likeContains(search) : '';
    const where = and(
      eq(contacts.organizationId, organizationId),
      isNotNull(contacts.deletedAt),
      search ? or(ilike(contacts.firstName, term), ilike(contacts.lastName, term), ilike(contacts.email, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select({ contact: contacts, companyName: companies.name })
        .from(contacts)
        .leftJoin(companies, and(eq(contacts.companyId, companies.id), isNull(companies.deletedAt)))
        .where(where)
        .orderBy(desc(contacts.deletedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(contacts).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.contact, companyName: r.companyName })), total: total?.value ?? 0 };
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.update(contacts).set(restoreSet).where(trashScope(organizationId, id)).returning();
    return row ?? null;
  }
}

export const contactsRepository = new ContactsRepository();
