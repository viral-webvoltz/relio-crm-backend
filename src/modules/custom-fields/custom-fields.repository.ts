import { and, asc, count, eq, max } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { customFieldDefinitions as defs } from '@/database/schema/custom-fields.js';
import type { CreateDefinitionInput, UpdateDefinitionInput } from './custom-fields.validation.js';
import type { EntityType } from './custom-fields.validate.js';

const scope = (organizationId: string, id: string) => and(eq(defs.organizationId, organizationId), eq(defs.id, id));

class CustomFieldsRepository {
  list({ organizationId, entityType, activeOnly }: { organizationId: string; entityType: EntityType; activeOnly: boolean }, executor: DbExecutor = db) {
    return executor
      .select()
      .from(defs)
      .where(and(eq(defs.organizationId, organizationId), eq(defs.entityType, entityType), activeOnly ? eq(defs.isActive, true) : undefined))
      .orderBy(asc(defs.position), asc(defs.createdAt));
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor.select().from(defs).where(scope(organizationId, id));
    return row ?? null;
  }

  async countActive({ organizationId, entityType }: { organizationId: string; entityType: EntityType }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ value: count() })
      .from(defs)
      .where(and(eq(defs.organizationId, organizationId), eq(defs.entityType, entityType), eq(defs.isActive, true)));
    return row?.value ?? 0;
  }

  async nextPosition({ organizationId, entityType }: { organizationId: string; entityType: EntityType }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ value: max(defs.position) })
      .from(defs)
      .where(and(eq(defs.organizationId, organizationId), eq(defs.entityType, entityType)));
    return (row?.value ?? -1) + 1;
  }

  async create({ organizationId, input, position }: { organizationId: string; input: CreateDefinitionInput; position: number }, executor: DbExecutor = db) {
    const [row] = await executor
      .insert(defs)
      .values({ ...input, options: input.options ?? null, position, organizationId })
      .returning();
    return row!;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateDefinitionInput }, executor: DbExecutor = db) {
    const [row] = await executor
      .update(defs)
      .set({ ...input, updatedAt: new Date() })
      .where(scope(organizationId, id))
      .returning();
    return row ?? null;
  }
}

export const customFieldsRepository = new CustomFieldsRepository();
