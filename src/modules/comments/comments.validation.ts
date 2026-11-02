import { z } from 'zod';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const entityTypes = ['deal', 'ticket'] as const;
const body = z.string().trim().min(1).max(5000);

export const commentListQuerySchema = listQuerySchema.pick({ page: true, limit: true }).extend({
  entityType: z.enum(entityTypes),
  entityId: z.uuid(),
});
export const createCommentSchema = z.object({ entityType: z.enum(entityTypes), entityId: z.uuid(), body });
export const updateCommentSchema = z.object({ body });

export type CommentListQuery = z.infer<typeof commentListQuerySchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
