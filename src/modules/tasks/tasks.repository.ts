import { and, count, desc, eq, gte, ilike, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db, type DbExecutor } from '@/config/database.js';
import { tasks, users } from '@/database/schema/index.js';
import { restoreSet, softDeleteSet } from '@/database/soft-delete.js';
import { orderByClause, priorityRank } from '@/shared/utils/sorting.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { TaskListQuery, UpdateTaskInput } from './tasks.validation.js';

type NewTask = typeof tasks.$inferInsert;

const scope = (organizationId: string, id: string) => and(eq(tasks.organizationId, organizationId), eq(tasks.id, id), isNull(tasks.deletedAt));

class TasksRepository {
  async assigneeExists({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, id), eq(users.isActive, true)));
    return Boolean(row);
  }

  async list({ organizationId, userId, query }: { organizationId: string; userId: string; query: TaskListQuery }, executor: DbExecutor = db) {
    const { page, limit, search, status, assignee, relatedType, relatedId, dueFrom, dueTo, sort, dir } = query;
    const where = and(
      eq(tasks.organizationId, organizationId),
      isNull(tasks.deletedAt),
      dueFrom ? gte(tasks.dueDate, dueFrom) : undefined,
      dueTo ? lte(tasks.dueDate, dueTo) : undefined,
      status ? eq(tasks.status, status) : undefined,
      assignee ? eq(tasks.assignedTo, assignee === 'me' ? userId : assignee) : undefined,
      relatedType ? eq(tasks.relatedType, relatedType) : undefined,
      relatedId ? eq(tasks.relatedId, relatedId) : undefined,
      search ? ilike(tasks.title, likeContains(search)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      executor
        .select({ task: tasks, assigneeName: users.fullName })
        .from(tasks)
        .leftJoin(users, eq(users.id, tasks.assignedTo))
        .where(where)
        // Default: open tasks first, soonest due first, undated last.
        .orderBy(
          ...orderByClause(
            {
              title: tasks.title,
              dueDate: tasks.dueDate,
              priority: priorityRank(tasks.priority),
              status: tasks.status,
              assignee: users.fullName,
              createdAt: tasks.createdAt,
            },
            { sort, dir },
            [sql`${tasks.status} desc, ${tasks.dueDate} asc nulls last, ${tasks.createdAt} desc`],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(tasks).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.task, assigneeName: r.assigneeName })), total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [task] = await executor.select().from(tasks).where(scope(organizationId, id));
    return task;
  }

  // Row lock: serializes concurrent updates of the same task (used for recurrence spawning).
  async findByIdForUpdate({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [task] = await executor.select().from(tasks).where(scope(organizationId, id)).for('update');
    return task;
  }

  async create({ values }: { values: NewTask }, executor: DbExecutor = db) {
    const [task] = await executor.insert(tasks).values(values).returning();
    return task!;
  }

  async update(
    { organizationId, id, input, completedAt }: { organizationId: string; id: string; input: UpdateTaskInput; completedAt?: Date | null },
    executor: DbExecutor = db,
  ) {
    const [task] = await executor
      .update(tasks)
      .set({ ...input, ...(completedAt !== undefined && { completedAt }), updatedAt: new Date() })
      .where(scope(organizationId, id))
      .returning();
    return task!;
  }

  async delete({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }, executor: DbExecutor = db) {
    const deleted = await executor.update(tasks).set(softDeleteSet(userId)).where(scope(organizationId, id)).returning({ id: tasks.id });
    return deleted.length > 0;
  }

  async listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }, executor: DbExecutor = db) {
    const { page, limit, search } = query;
    const where = and(eq(tasks.organizationId, organizationId), isNotNull(tasks.deletedAt), search ? ilike(tasks.title, likeContains(search)) : undefined);
    const [rows, [total]] = await Promise.all([
      executor
        .select({ task: tasks, assigneeName: users.fullName })
        .from(tasks)
        .leftJoin(users, eq(users.id, tasks.assignedTo))
        .where(where)
        .orderBy(desc(tasks.deletedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      executor.select({ value: count() }).from(tasks).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.task, assigneeName: r.assigneeName })), total: total?.value ?? 0 };
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [task] = await executor
      .update(tasks)
      .set(restoreSet)
      .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, id), isNotNull(tasks.deletedAt)))
      .returning();
    return task ?? null;
  }
}

export const tasksRepository = new TasksRepository();
