import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { comments } from '@/database/schema/collaboration.js';
import { deals } from '@/database/schema/sales.js';
import { users } from '@/database/schema/identity.js';
import { supportTickets } from '@/database/schema/support.js';
import { getOffset } from '@/shared/pagination/index.js';
import type { CommentListQuery } from './comments.validation.js';

const live = (organizationId: string) => and(eq(comments.organizationId, organizationId), isNull(comments.deletedAt));

class CommentsRepository {
  async list({ organizationId, query }: { organizationId: string; query: CommentListQuery }, executor: DbExecutor = db) {
    const where = and(live(organizationId), eq(comments.entityType, query.entityType), eq(comments.entityId, query.entityId));
    const [rows, [total]] = await Promise.all([
      executor
        .select({ comment: comments, authorName: users.fullName })
        .from(comments)
        .leftJoin(users, eq(users.id, comments.authorId))
        .where(where)
        .orderBy(asc(comments.createdAt), asc(comments.id))
        .limit(query.limit)
        .offset(getOffset(query)),
      executor.select({ value: count() }).from(comments).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.comment, authorName: r.authorName })), total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select()
      .from(comments)
      .where(and(live(organizationId), eq(comments.id, id)));
    return row;
  }

  async insert(values: typeof comments.$inferInsert, executor: DbExecutor = db) {
    const [row] = await executor.insert(comments).values(values).returning();
    return row;
  }

  async update({ organizationId, id, body, mentions }: { organizationId: string; id: string; body: string; mentions: string[] }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(comments)
      .set({ body, mentions, editedAt: new Date() })
      .where(and(live(organizationId), eq(comments.id, id)))
      .returning();
    return row;
  }

  async softDelete({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    await executor
      .update(comments)
      .set({ deletedAt: new Date() })
      .where(and(live(organizationId), eq(comments.id, id)));
  }

  async activeUserIds({ organizationId, ids }: { organizationId: string; ids: string[] }, executor: DbExecutor = db) {
    if (ids.length === 0) return [];
    const rows = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true), inArray(users.id, ids)));
    return rows.map((r) => r.id);
  }

  // Returns a label for the target, or undefined when it does not exist in the organization (or is deleted).
  async targetTitle(
    { organizationId, entityType, entityId }: { organizationId: string; entityType: 'deal' | 'ticket'; entityId: string },
    executor: DbExecutor = db,
  ) {
    if (entityType === 'deal') {
      const [row] = await executor
        .select({ title: deals.title })
        .from(deals)
        .where(and(eq(deals.organizationId, organizationId), eq(deals.id, entityId), isNull(deals.deletedAt)));
      return row?.title;
    }
    const [row] = await executor
      .select({ subject: supportTickets.subject })
      .from(supportTickets)
      .where(and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.id, entityId)));
    return row?.subject;
  }
}

export const commentsRepository = new CommentsRepository();
