import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  search: z.string().trim().max(100).optional(),
  sort: z.string().trim().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const idParamSchema = z.object({ id: z.uuid() });

export const getOffset = ({ page, limit }: { page: number; limit: number }) => (page - 1) * limit;

export const pageMeta = (query: ListQuery, total: number) => ({
  page: query.page,
  limit: query.limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / query.limit)),
});
