import { and, asc, eq } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { sessions, users } from '@/database/schema/index.js';

const userColumns = { id: users.id, email: users.email, fullName: users.fullName, isActive: users.isActive, createdAt: users.createdAt };

class UsersRepository {
  async list({ organizationId }: { organizationId: string }) {
    return db.select(userColumns).from(users).where(eq(users.organizationId, organizationId)).orderBy(asc(users.fullName));
  }

  async listActiveOptions({ organizationId }: { organizationId: string }) {
    return db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true)))
      .orderBy(asc(users.fullName));
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, id)));
    return user;
  }

  async create(
    { organizationId, email, fullName, passwordHash }: { organizationId: string; email: string; fullName: string; passwordHash: string },
    executor: DbExecutor = db,
  ) {
    const [user] = await executor.insert(users).values({ organizationId, email, fullName, passwordHash }).returning(userColumns);
    return user!;
  }

  async update(
    { organizationId, id, changes }: { organizationId: string; id: string; changes: { fullName?: string; isActive?: boolean; passwordHash?: string } },
    executor: DbExecutor = db,
  ) {
    await executor
      .update(users)
      .set({ ...changes, updatedAt: new Date() })
      .where(and(eq(users.organizationId, organizationId), eq(users.id, id)));
  }

  async deleteSessions({ userId }: { userId: string }, executor: DbExecutor = db) {
    await executor.delete(sessions).where(eq(sessions.userId, userId));
  }
}

export const usersRepository = new UsersRepository();
