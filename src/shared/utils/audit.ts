import { db, type DbExecutor } from '@/config/database.js';
import { auditLogs } from '@/database/schema/index.js';
import { logger } from '@/shared/utils/logger.js';

type AuditEntry = {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

// Pass the transaction executor when the audited change is in one, so the record commits (or rolls back) with it.
// Never put secrets (passwords, tokens) in metadata.
export async function audit(entry: AuditEntry, executor: DbExecutor = db) {
  try {
    await executor
      .insert(auditLogs)
      .values({ ...entry, actorUserId: entry.actorUserId ?? null, targetId: entry.targetId ?? null, metadata: entry.metadata ?? {} });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'failed to write audit log');
  }
  logger.info({ audit: entry }, `audit: ${entry.action}`);
}
