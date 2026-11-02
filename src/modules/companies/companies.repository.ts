import { and, count, desc, eq, ilike, isNotNull, isNull } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { companies } from '@/database/schema/index.js';
import { restoreSet, softDeleteSet } from '@/database/soft-delete.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { CreateCompanyInput, UpdateCompanyInput } from './companies.validation.js';

const scope = (organizationId: string, id: string) => and(eq(companies.organizationId, organizationId), eq(companies.id, id), isNull(companies.deletedAt));
const trashScope = (organizationId: string, id: string) =>
  and(eq(companies.organizationId, organizationId), eq(companies.id, id), isNotNull(companies.deletedAt));

class CompaniesRepository {
  async list({ organizationId, query }: { organizationId: string; query: ListQuery }, executor: DbExecutor = db) {
    const { page, limit, search, sort, dir } = query;
    const where = and(
      eq(companies.organizationId, organizationId),
      isNull(companies.deletedAt),
      search ? ilike(companies.name, likeContains(search)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select()
        .from(companies)
        .where(where)
        .orderBy(
          ...orderByClause({ name: companies.name, industry: companies.industry, createdAt: companies.createdAt }, { sort, dir }, [desc(companies.createdAt)]),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(companies).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(companies).where(scope(organizationId, id));
    return row ?? null;
  }

  async create({ organizationId, input }: { organizationId: string; input: CreateCompanyInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .insert(companies)
      .values({ ...input, organizationId })
      .returning();
    return row!;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateCompanyInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(companies)
      .set({ ...input, updatedAt: new Date() })
      .where(scope(organizationId, id))
      .returning();
    return row ?? null;
  }

  async remove({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }, executor: DbExecutor = db) {
    const deleted = await executor.update(companies).set(softDeleteSet(userId)).where(scope(organizationId, id)).returning({ id: companies.id });
    return deleted.length > 0;
  }

  async listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }, executor: DbExecutor = db) {
    const { page, limit, search } = query;
    const where = and(
      eq(companies.organizationId, organizationId),
      isNotNull(companies.deletedAt),
      search ? ilike(companies.name, likeContains(search)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select()
        .from(companies)
        .where(where)
        .orderBy(desc(companies.deletedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(companies).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.update(companies).set(restoreSet).where(trashScope(organizationId, id)).returning();
    return row ?? null;
  }
}

export const companiesRepository = new CompaniesRepository();
