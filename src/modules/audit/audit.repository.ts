import { and, count, desc, eq, gte, lt } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { auditLogs, users } from '@/database/schema/index.js';
import type { AuditListQuery } from './audit.validation.js';

class AuditRepository {
  async list({ organizationId, query }: { organizationId: string; query: AuditListQuery }) {
    const { page, limit, entityType, entityId, actorId, action, from, to } = query;
    const where = and(
      eq(auditLogs.organizationId, organizationId),
      entityType ? eq(auditLogs.targetType, entityType) : undefined,
      entityId ? eq(auditLogs.targetId, entityId) : undefined,
      actorId ? eq(auditLogs.actorUserId, actorId) : undefined,
      action ? eq(auditLogs.action, action) : undefined,
      from ? gte(auditLogs.createdAt, from) : undefined,
      to ? lt(auditLogs.createdAt, to) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.targetType,
          entityId: auditLogs.targetId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
          actorId: auditLogs.actorUserId,
          actorName: users.fullName,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(where)
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(auditLogs).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }
}

export const auditRepository = new AuditRepository();
