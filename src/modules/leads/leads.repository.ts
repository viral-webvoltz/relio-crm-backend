import { and, count, desc, eq, ilike, isNotNull, isNull, or } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { contacts, leads, users } from '@/database/schema/index.js';
import { restoreSet, softDeleteSet } from '@/database/soft-delete.js';
import { orderByClause, priorityRank } from '@/shared/utils/sorting.js';
import { cfFilterConditions, mergeCustomFields } from '@/modules/custom-fields/custom-fields.validate.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { CreateLeadInput, LeadListQuery, UpdateLeadInput } from './leads.validation.js';

const scope = (organizationId: string, id: string) => and(eq(leads.organizationId, organizationId), eq(leads.id, id), isNull(leads.deletedAt));
const trashScope = (organizationId: string, id: string) => and(eq(leads.organizationId, organizationId), eq(leads.id, id), isNotNull(leads.deletedAt));

type LeadRow = typeof leads.$inferSelect;

class LeadsRepository {
  async list({ organizationId, query }: { organizationId: string; query: LeadListQuery }, executor: DbExecutor = db) {
    const { page, limit, search, status, priority, source, sort, dir, cf } = query;
    const term = search ? likeContains(search) : '';
    const where = and(
      eq(leads.organizationId, organizationId),
      isNull(leads.deletedAt),
      status ? eq(leads.status, status) : undefined,
      priority ? eq(leads.priority, priority) : undefined,
      source ? eq(leads.source, source) : undefined,
      ...cfFilterConditions(leads.customFields, cf),
      search ? or(ilike(leads.firstName, term), ilike(leads.lastName, term), ilike(leads.email, term), ilike(leads.companyName, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select()
        .from(leads)
        .where(where)
        .orderBy(
          ...orderByClause(
            {
              name: leads.firstName,
              source: leads.source,
              status: leads.status,
              priority: priorityRank(leads.priority),
              score: leads.score,
              followUpDate: leads.followUpDate,
              createdAt: leads.createdAt,
            },
            { sort, dir },
            [desc(leads.createdAt)],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(leads).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(leads).where(scope(organizationId, id));
    return row ?? null;
  }

  // Row lock: concurrent conversions of the same lead are serialised.
  async findByIdForUpdate({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(leads).where(scope(organizationId, id)).for('update');
    return row ?? null;
  }

  async userExists({ organizationId, userId }: { organizationId: string; userId: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, userId), eq(users.isActive, true)));
    return Boolean(row);
  }

  async create({ organizationId, input }: { organizationId: string; input: CreateLeadInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .insert(leads)
      .values({ ...input, organizationId })
      .returning();
    return row!;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateLeadInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(leads)
      .set({ ...input, customFields: input.customFields ? mergeCustomFields(leads.customFields, input.customFields) : undefined, updatedAt: new Date() })
      .where(scope(organizationId, id))
      .returning();
    return row ?? null;
  }

  async remove({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }, executor: DbExecutor = db) {
    const deleted = await executor.update(leads).set(softDeleteSet(userId)).where(scope(organizationId, id)).returning({ id: leads.id });
    return deleted.length > 0;
  }

  async listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }, executor: DbExecutor = db) {
    const { page, limit, search } = query;
    const term = search ? likeContains(search) : '';
    const where = and(
      eq(leads.organizationId, organizationId),
      isNotNull(leads.deletedAt),
      search ? or(ilike(leads.firstName, term), ilike(leads.lastName, term), ilike(leads.email, term), ilike(leads.companyName, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select()
        .from(leads)
        .where(where)
        .orderBy(desc(leads.deletedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(leads).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.update(leads).set(restoreSet).where(trashScope(organizationId, id)).returning();
    return row ?? null;
  }

  async findContactByEmail({ organizationId, email }: { organizationId: string; email: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select()
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.email, email), isNull(contacts.deletedAt)));
    return row ?? null;
  }

  async createContactFromLead({ organizationId, lead }: { organizationId: string; lead: LeadRow }, executor: DbExecutor = db) {
    const [row] = await executor
      .insert(contacts)
      .values({ organizationId, firstName: lead.firstName, lastName: lead.lastName, email: lead.email, phone: lead.phone, notes: lead.notes })
      .returning();
    return row!;
  }

  async markConverted({ id, contactId }: { id: string; contactId: string }, executor: DbExecutor = db) {
    await executor
      .update(leads)
      .set({ status: 'converted', convertedContactId: contactId, convertedAt: new Date(), updatedAt: new Date() })
      .where(eq(leads.id, id));
  }
}

export const leadsRepository = new LeadsRepository();
