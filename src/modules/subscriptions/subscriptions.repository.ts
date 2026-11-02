import { and, asc, count, desc, eq, ilike, isNotNull, lt, or, sql, isNull } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { organizations, subscriptionItems, subscriptionRuns, subscriptions } from '@/database/schema/index.js';
import { likeContains } from '@/shared/utils/like.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import type { SubscriptionListQuery } from './subscriptions.validation.js';

type NewSubscription = typeof subscriptions.$inferInsert;
type NewItem = typeof subscriptionItems.$inferInsert;
type NewRun = typeof subscriptionRuns.$inferInsert;

const scope = (organizationId: string, id: string) => and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.id, id));
const RETRY_AFTER_HOURS = 6;

class SubscriptionsRepository {
  async list({ organizationId, query: { page, limit, search, status, contactId, sort, dir } }: { organizationId: string; query: SubscriptionListQuery }) {
    const where = and(
      eq(subscriptions.organizationId, organizationId),
      status ? eq(subscriptions.status, status) : undefined,
      contactId ? eq(subscriptions.contactId, contactId) : undefined,
      search ? or(ilike(subscriptions.name, likeContains(search)), ilike(subscriptions.customerName, likeContains(search))) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(subscriptions)
        .where(where)
        .orderBy(
          ...orderByClause(
            {
              name: subscriptions.name,
              customer: subscriptions.customerName,
              status: subscriptions.status,
              nextRunOn: subscriptions.nextRunOn,
              createdAt: subscriptions.createdAt,
            },
            { sort, dir },
            [desc(subscriptions.createdAt)],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(subscriptions).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(subscriptions).where(scope(organizationId, id));
    return row;
  }

  // skipLocked: the scheduler passes over a subscription another instance is billing right now.
  async lockById({ organizationId, id, skipLocked = false }: { organizationId: string; id: string; skipLocked?: boolean }, executor: DbExecutor = db) {
    const [row] = await executor
      .select()
      .from(subscriptions)
      .where(scope(organizationId, id))
      .for('update', skipLocked ? { skipLocked: true } : undefined);
    return row;
  }

  findItems({ subscriptionId }: { subscriptionId: string }, executor: DbExecutor = db) {
    return executor.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subscriptionId)).orderBy(asc(subscriptionItems.productName));
  }

  async insert(values: NewSubscription, executor: DbExecutor = db) {
    const [row] = await executor.insert(subscriptions).values(values).returning();
    return row!;
  }

  async update({ id, set }: { id: string; set: Partial<NewSubscription> }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(subscriptions)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
      .returning();
    return row!;
  }

  async insertItems(values: NewItem[], executor: DbExecutor = db) {
    await executor.insert(subscriptionItems).values(values);
  }

  async deleteItems({ subscriptionId }: { subscriptionId: string }, executor: DbExecutor = db) {
    await executor.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subscriptionId));
  }

  async remove({ id }: { id: string }, executor: DbExecutor = db) {
    await executor.delete(subscriptions).where(eq(subscriptions.id, id));
  }

  async insertRun(values: NewRun, executor: DbExecutor = db) {
    const [row] = await executor.insert(subscriptionRuns).values(values).returning();
    return row!;
  }

  async invoicedRunExists({ subscriptionId, scheduledFor }: { subscriptionId: string; scheduledFor: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: subscriptionRuns.id })
      .from(subscriptionRuns)
      .where(
        and(eq(subscriptionRuns.subscriptionId, subscriptionId), eq(subscriptionRuns.scheduledFor, scheduledFor), eq(subscriptionRuns.status, 'invoiced')),
      );
    return Boolean(row);
  }

  async listRuns({ subscriptionId, page, limit }: { subscriptionId: string; page: number; limit: number }) {
    const where = eq(subscriptionRuns.subscriptionId, subscriptionId);
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(subscriptionRuns)
        .where(where)
        .orderBy(desc(subscriptionRuns.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(subscriptionRuns).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async timezoneOf({ organizationId }: { organizationId: string }) {
    const [row] = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId));
    return row?.timezone ?? 'UTC';
  }

  // Active subscriptions whose billing date is today or earlier somewhere on Earth (the caller narrows it to each organization's own date),
  // skipping ones that failed less than RETRY_AFTER_HOURS ago.
  dueCandidates({ limit }: { limit: number }) {
    return db
      .select({ id: subscriptions.id, organizationId: subscriptions.organizationId, nextRunOn: subscriptions.nextRunOn, timezone: organizations.timezone })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(
        and(
          eq(subscriptions.status, 'active'),
          isNotNull(subscriptions.nextRunOn),
          sql`${subscriptions.nextRunOn} <= current_date + 1`,
          or(
            isNull(subscriptions.lastAttemptAt),
            eq(subscriptions.failureCount, 0),
            lt(subscriptions.lastAttemptAt, sql`now() - ${RETRY_AFTER_HOURS} * interval '1 hour'`),
          ),
        ),
      )
      .orderBy(asc(subscriptions.nextRunOn))
      .limit(limit);
  }
}

export const subscriptionsRepository = new SubscriptionsRepository();
