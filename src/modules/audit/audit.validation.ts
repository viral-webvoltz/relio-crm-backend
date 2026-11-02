import { z } from 'zod';
import { listQuerySchema } from '@/shared/pagination/index.js';

const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const auditListQuerySchema = listQuerySchema.pick({ page: true, limit: true }).extend({
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  action: z.string().trim().min(1).max(60).optional(),
  from: instant.optional(),
  to: instant.optional(),
});

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
