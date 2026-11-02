import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { activities, companies, contacts, deals, leads, tasks, users } from '@/database/schema/index.js';
import type { CreateActivityInput, UpdateActivityInput } from './activities.validation.js';

type RelatedType = 'lead' | 'deal' | 'contact' | 'company';

const RELATED_TABLES = { lead: leads, deal: deals, contact: contacts, company: companies } as const;

const scope = (organizationId: string, id: string) => and(eq(activities.organizationId, organizationId), eq(activities.id, id));

const flatten = (rows: { activity: typeof activities.$inferSelect; createdByName: string | null }[]) =>
  rows.map((r) => ({ ...r.activity, createdByName: r.createdByName }));

class ActivitiesRepository {
  private withAuthor(executor: DbExecutor) {
    return executor.select({ activity: activities, createdByName: users.fullName }).from(activities).leftJoin(users, eq(users.id, activities.createdBy));
  }

  // Everything recently logged across the organization, newest first.
  async listRecent({ organizationId, limit, types }: { organizationId: string; limit: number; types: readonly RelatedType[] }, executor: DbExecutor = db) {
    if (types.length === 0) return [];
    const rows = await this.withAuthor(executor)
      .where(and(eq(activities.organizationId, organizationId), inArray(activities.relatedType, [...types])))
      .orderBy(desc(activities.occurredAt))
      .limit(limit);
    return flatten(rows);
  }

  async findRelatedType({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select({ relatedType: activities.relatedType }).from(activities).where(scope(organizationId, id));
    return row?.relatedType;
  }

  // Timeline of one record, newest first.
  async listForRecord(
    { organizationId, relatedType, relatedId, limit }: { organizationId: string; relatedType: RelatedType; relatedId: string; limit: number },
    executor: DbExecutor = db,
  ) {
    const rows = await this.withAuthor(executor)
      .where(and(eq(activities.organizationId, organizationId), eq(activities.relatedType, relatedType), eq(activities.relatedId, relatedId)))
      .orderBy(desc(activities.occurredAt))
      .limit(limit);
    return flatten(rows);
  }

  async create(
    { organizationId, userId, input }: { organizationId: string; userId: string; input: Omit<CreateActivityInput, 'occurredAt'> & { occurredAt?: Date } },
    executor: DbExecutor = db,
  ) {
    const [activity] = await executor
      .insert(activities)
      .values({ ...input, organizationId, createdBy: userId })
      .returning();
    return activity!;
  }

  async update(
    { organizationId, id, changes }: { organizationId: string; id: string; changes: Omit<UpdateActivityInput, 'occurredAt'> & { occurredAt?: Date } },
    executor: DbExecutor = db,
  ) {
    const [activity] = await executor.update(activities).set(changes).where(scope(organizationId, id)).returning();
    return activity;
  }

  async delete({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const deleted = await executor.delete(activities).where(scope(organizationId, id)).returning({ id: activities.id });
    return deleted.length > 0;
  }

  // Tasks and activities point at records of several kinds without a foreign key, so the target is checked here.
  async relatedExists({ organizationId, type, id }: { organizationId: string; type: RelatedType; id: string }, executor: DbExecutor = db) {
    const table = RELATED_TABLES[type];
    const [row] = await executor
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.organizationId, organizationId), eq(table.id, id), isNull(table.deletedAt)));
    return Boolean(row);
  }

  async deleteTasksFor({ organizationId, type, id }: { organizationId: string; type: RelatedType; id: string }, executor: DbExecutor = db) {
    await executor.delete(tasks).where(and(eq(tasks.organizationId, organizationId), eq(tasks.relatedType, type), eq(tasks.relatedId, id)));
  }

  async deleteForRecord({ organizationId, type, id }: { organizationId: string; type: RelatedType; id: string }, executor: DbExecutor = db) {
    await executor.delete(activities).where(and(eq(activities.organizationId, organizationId), eq(activities.relatedType, type), eq(activities.relatedId, id)));
  }
}

export const activitiesRepository = new ActivitiesRepository();
