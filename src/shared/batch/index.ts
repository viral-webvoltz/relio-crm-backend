import { z } from 'zod';
import type { AuthContext } from '@/shared/types/auth.js';
import type { PermissionKey } from '@/shared/constants/permissions.js';
import { AppError, ForbiddenError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/logger.js';

export const MAX_BATCH_SIZE = 100;

const idsSchema = z
  .array(z.uuid())
  .min(1)
  .max(MAX_BATCH_SIZE)
  .transform((ids) => [...new Set(ids)]);

// { action: 'delete', ids } | { action: 'update', ids, changes }. `changes` is the per-resource whitelist: unknown keys are rejected, and at least one is required.
export const batchSchema = <T extends z.ZodObject>(changes: T) =>
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('delete'), ids: idsSchema }),
    z.object({
      action: z.literal('update'),
      ids: idsSchema,
      changes: changes.strict().refine((value) => Object.keys(value).length > 0, 'At least one change is required'),
    }),
  ]);

export type BatchResult = { succeeded: string[]; failed: { id: string; code: string; message: string }[] };

// The caller passes the permission the single-record endpoint for this action needs (e.g. leads.update / leads.delete).
export function assertBatchPermission(auth: AuthContext, key: PermissionKey) {
  if (!auth.permissions.includes(key)) throw new ForbiddenError();
}

// Runs the same single-record code path for each id, one at a time; one failure never stops or rolls back the others.
export async function runBatch(ids: string[], run: (id: string) => Promise<unknown>): Promise<BatchResult> {
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of ids) {
    try {
      await run(id);
      result.succeeded.push(id);
    } catch (err) {
      if (err instanceof AppError) {
        result.failed.push({ id, code: err.code, message: err.message });
      } else {
        logger.error({ err, id }, 'batch item failed');
        result.failed.push({ id, code: 'INTERNAL_ERROR', message: 'Unexpected error' });
      }
    }
  }
  return result;
}
