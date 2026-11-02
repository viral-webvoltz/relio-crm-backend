import { z } from 'zod';
import { relatedTypes } from './activities.related.js';

export const activityTypes = ['note', 'call', 'meeting', 'email'] as const;

export const createActivitySchema = z.object({
  type: z.enum(activityTypes),
  subject: z.string().trim().min(1).max(200),
  body: z
    .string()
    .trim()
    .max(5000)
    .transform((v) => v || null)
    .nullish(),
  relatedType: z.enum(relatedTypes),
  relatedId: z.uuid(),
  occurredAt: z.iso.datetime().optional(),
});

// The record an activity belongs to cannot change.
export const updateActivitySchema = createActivitySchema.omit({ relatedType: true, relatedId: true }).partial();

export const activityListQuerySchema = z.object({
  relatedType: z.enum(relatedTypes),
  relatedId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const recentActivityQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
