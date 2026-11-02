import { z } from 'zod';
import { LIST_RESOURCES } from '@/modules/preferences/preferences.validation.js';

export const resourceSchema = z.enum(LIST_RESOURCES);

export const viewQuerySchema = z
  .object({
    filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).refine((f) => Object.keys(f).length <= 20, 'At most 20 filters'),
    sort: z.string().max(60),
    dir: z.enum(['asc', 'desc']),
    columns: z.array(z.string().min(1).max(60)).max(50),
  })
  .partial()
  .strict();

const nameSchema = z.string().trim().min(1).max(80);

export const listViewsQuerySchema = z.object({ resource: resourceSchema });
export const createViewSchema = z.object({ resource: resourceSchema, name: nameSchema, query: viewQuerySchema, isShared: z.boolean().default(false) }).strict();
export const updateViewSchema = z.object({ name: nameSchema, query: viewQuerySchema, isShared: z.boolean() }).partial().strict();

export type ViewQuery = z.infer<typeof viewQuerySchema>;
export type ListViewsQuery = z.infer<typeof listViewsQuerySchema>;
export type CreateViewInput = z.infer<typeof createViewSchema>;
export type UpdateViewInput = z.infer<typeof updateViewSchema>;
