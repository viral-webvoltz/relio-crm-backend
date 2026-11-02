import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { notifications } from '@/database/schema/notifications.js';
import { getOffset } from '@/shared/pagination/index.js';
import type { NotificationListQuery } from './notifications.validation.js';

const own = (organizationId: string, userId: string) => and(eq(notifications.organizationId, organizationId), eq(notifications.userId, userId));

class NotificationsRepository {
  async list({ organizationId, userId, query }: { organizationId: string; userId: string; query: NotificationListQuery }, executor: DbExecutor = db) {
    const [rows, [total], [unread]] = await Promise.all([
      executor
        .select()
        .from(notifications)
        .where(own(organizationId, userId))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit)
        .offset(getOffset(query)),
      executor.select({ value: count() }).from(notifications).where(own(organizationId, userId)),
      executor
        .select({ value: count() })
        .from(notifications)
        .where(and(own(organizationId, userId), isNull(notifications.readAt))),
    ]);
    return { rows, total: total?.value ?? 0, unreadCount: unread?.value ?? 0 };
  }

  // Already-read rows still match, so re-marking one is a harmless no-op rather than a 404.
  async markRead({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(own(organizationId, userId), eq(notifications.id, id)))
      .returning();
    return row;
  }

  async markAllRead({ organizationId, userId }: { organizationId: string; userId: string }, executor: DbExecutor = db) {
    const rows = await executor
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(own(organizationId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }

  async insert(values: typeof notifications.$inferInsert, executor: DbExecutor = db) {
    await executor.insert(notifications).values(values);
  }
}

export const notificationsRepository = new NotificationsRepository();
