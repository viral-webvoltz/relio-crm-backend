import { and, asc, count, desc, eq, ilike, isNotNull, isNull, max } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db, type DbExecutor } from '@/config/database.js';
import { companies, contacts, deals, pipelines, pipelineStages } from '@/database/schema/index.js';
import { restoreSet, softDeleteSet } from '@/database/soft-delete.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import { cfFilterConditions, mergeCustomFields } from '@/modules/custom-fields/custom-fields.validate.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { CreateDealInput, DealListQuery, UpdateDealInput } from './sales.validation.js';

type NewStage = typeof pipelineStages.$inferInsert;

const dealScope = (organizationId: string, id: string) => and(eq(deals.organizationId, organizationId), eq(deals.id, id), isNull(deals.deletedAt));

class SalesRepository {
  async findDefaultPipeline({ organizationId }: { organizationId: string }, executor: DbExecutor = db) {
    const [pipeline] = await executor
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.organizationId, organizationId), eq(pipelines.isDefault, true)));
    return pipeline;
  }

  // Returns undefined when another request already seeded the default pipeline (partial unique index).
  async insertDefaultPipeline({ organizationId }: { organizationId: string }, executor: DbExecutor = db) {
    const [created] = await executor.insert(pipelines).values({ organizationId, name: 'Sales pipeline', isDefault: true }).onConflictDoNothing().returning();
    return created;
  }

  async insertStages({ stages }: { stages: NewStage[] }, executor: DbExecutor = db) {
    await executor.insert(pipelineStages).values(stages);
  }

  async listStages({ pipelineId }: { pipelineId: string }, executor: DbExecutor = db) {
    return executor.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(asc(pipelineStages.position));
  }

  async findFirstStage({ pipelineId }: { pipelineId: string }, executor: DbExecutor = db) {
    const [stage] = await executor
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(asc(pipelineStages.position))
      .limit(1);
    return stage;
  }

  async findStage({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [stage] = await executor
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.organizationId, organizationId), eq(pipelineStages.id, id)));
    return stage;
  }

  async listDeals({ organizationId, query }: { organizationId: string; query: DealListQuery }, executor: DbExecutor = db) {
    const { page, limit, search, stageId, sort, dir, cf } = query;
    const where = and(
      eq(deals.organizationId, organizationId),
      isNull(deals.deletedAt),
      stageId ? eq(deals.stageId, stageId) : undefined,
      ...cfFilterConditions(deals.customFields, cf),
      search ? ilike(deals.title, likeContains(search)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select()
        .from(deals)
        .where(where)
        .orderBy(
          ...orderByClause(
            { title: deals.title, valueMinor: deals.valueMinor, expectedCloseDate: deals.expectedCloseDate, createdAt: deals.createdAt },
            { sort, dir },
            [desc(deals.createdAt)],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(deals).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async listDealsForPipeline({ organizationId, pipelineId }: { organizationId: string; pipelineId: string }, executor: DbExecutor = db) {
    return executor
      .select()
      .from(deals)
      .where(and(eq(deals.organizationId, organizationId), eq(deals.pipelineId, pipelineId), isNull(deals.deletedAt)))
      .orderBy(asc(deals.position));
  }

  async contactExists({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNull(contacts.deletedAt)));
    return Boolean(row);
  }

  async companyExists({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.id, id), isNull(companies.deletedAt)));
    return Boolean(row);
  }

  async nextPosition({ organizationId, stageId }: { organizationId: string; stageId: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ value: max(deals.position) })
      .from(deals)
      .where(and(eq(deals.organizationId, organizationId), eq(deals.stageId, stageId), isNull(deals.deletedAt)));
    return (row?.value ?? -1) + 1;
  }

  async findDeal({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [deal] = await executor.select().from(deals).where(dealScope(organizationId, id));
    return deal;
  }

  async createDeal(
    {
      organizationId,
      ownerId,
      pipelineId,
      stageId,
      position,
      fields,
    }: {
      organizationId: string;
      ownerId: string;
      pipelineId: string;
      stageId: string;
      position: number;
      fields: Omit<CreateDealInput, 'stageId'>;
    },
    executor: DbExecutor = db,
  ) {
    const [deal] = await executor
      .insert(deals)
      .values({ ...fields, organizationId, ownerId, pipelineId, stageId, position })
      .returning();
    return deal!;
  }

  async updateDeal({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateDealInput }, executor: DbExecutor = db) {
    const [deal] = await executor
      .update(deals)
      .set({ ...input, customFields: input.customFields ? mergeCustomFields(deals.customFields, input.customFields) : undefined, updatedAt: new Date() })
      .where(dealScope(organizationId, id))
      .returning();
    return deal;
  }

  async moveDeal(
    { organizationId, id, stageId, position, lostReason }: { organizationId: string; id: string; stageId: string; position: number; lostReason: string | null },
    executor: DbExecutor = db,
  ) {
    const [moved] = await executor.update(deals).set({ stageId, position, lostReason, updatedAt: new Date() }).where(dealScope(organizationId, id)).returning();
    return moved!;
  }

  async deleteDeal({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }, executor: DbExecutor = db) {
    const deleted = await executor.update(deals).set(softDeleteSet(userId)).where(dealScope(organizationId, id)).returning({ id: deals.id });
    return deleted.length > 0;
  }

  async listDeletedDeals({ organizationId, query }: { organizationId: string; query: ListQuery }, executor: DbExecutor = db) {
    const { page, limit, search } = query;
    const where = and(eq(deals.organizationId, organizationId), isNotNull(deals.deletedAt), search ? ilike(deals.title, likeContains(search)) : undefined);
    const [rows, [total]] = await Promise.all([
      executor
        .select()
        .from(deals)
        .where(where)
        .orderBy(desc(deals.deletedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(deals).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async restoreDeal({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [deal] = await executor
      .update(deals)
      .set(restoreSet)
      .where(and(eq(deals.organizationId, organizationId), eq(deals.id, id), isNotNull(deals.deletedAt)))
      .returning();
    return deal ?? null;
  }
}

export const salesRepository = new SalesRepository();
