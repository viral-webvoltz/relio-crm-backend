import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { savedViews } from '@/database/schema/preferences.js';
import type { CreateViewInput, UpdateViewInput } from './saved-views.validation.js';

const scope = (organizationId: string, id: string) => and(eq(savedViews.organizationId, organizationId), eq(savedViews.id, id));

class SavedViewsRepository {
  // Own views plus views other people in the organization shared.
  list({ organizationId, userId, resource }: { organizationId: string; userId: string; resource: string }, executor: DbExecutor = db) {
    return executor
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.organizationId, organizationId),
          eq(savedViews.resource, resource),
          or(eq(savedViews.ownerId, userId), eq(savedViews.isShared, true)),
        ),
      )
      .orderBy(asc(savedViews.name));
  }

  async findVisible({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select()
      .from(savedViews)
      .where(and(scope(organizationId, id), or(eq(savedViews.ownerId, userId), eq(savedViews.isShared, true))))
      .limit(1);
    return row;
  }

  // Serialises concurrent creates for one user so the per-resource cap cannot be raced past.
  lockOwner({ userId }: { userId: string }, executor: DbExecutor = db) {
    return executor.execute(sql`select pg_advisory_xact_lock(hashtext(${`saved_views:${userId}`}))`);
  }

  async countOwned({ organizationId, userId, resource }: { organizationId: string; userId: string; resource: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ total: count() })
      .from(savedViews)
      .where(and(eq(savedViews.organizationId, organizationId), eq(savedViews.ownerId, userId), eq(savedViews.resource, resource)));
    return row?.total ?? 0;
  }

  async create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateViewInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .insert(savedViews)
      .values({ organizationId, ownerId: userId, resource: input.resource, name: input.name, query: input.query, isShared: input.isShared })
      .returning();
    return row;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateViewInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(savedViews)
      .set({ ...input, updatedAt: new Date() })
      .where(scope(organizationId, id))
      .returning();
    return row;
  }

  async remove({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const rows = await executor.delete(savedViews).where(scope(organizationId, id)).returning({ id: savedViews.id });
    return rows.length > 0;
  }
}

export const savedViewsRepository = new SavedViewsRepository();
