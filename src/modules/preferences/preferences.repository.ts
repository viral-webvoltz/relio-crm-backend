import { eq } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { userPreferences } from '@/database/schema/preferences.js';

class PreferencesRepository {
  listByUser({ userId }: { userId: string }, executor: DbExecutor = db) {
    return executor.select({ key: userPreferences.key, value: userPreferences.value }).from(userPreferences).where(eq(userPreferences.userId, userId));
  }

  async upsert({ userId, organizationId, key, value }: { userId: string; organizationId: string; key: string; value: unknown }, executor: DbExecutor = db) {
    await executor
      .insert(userPreferences)
      .values({ userId, organizationId, key, value })
      .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value, updatedAt: new Date() } });
  }
}

export const preferencesRepository = new PreferencesRepository();
