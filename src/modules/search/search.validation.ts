import { z } from 'zod';
import { likeContains } from '@/shared/utils/like.js';

export const SEARCH_TYPES = ['contacts', 'leads', 'companies', 'deals'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  // "contacts,leads" -> ['contacts', 'leads']; omitted means every type.
  types: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(z.array(z.enum(SEARCH_TYPES)))
    .transform((t) => (t.length ? [...new Set(t)] : [...SEARCH_TYPES])),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

// Escaped ilike patterns for a trimmed term: '%x%' (match anywhere) and 'x%' (prefix, ranked higher).
export const searchPatterns = (q: string) => {
  const contains = likeContains(q);
  return { contains, prefix: contains.slice(1) };
};
