import { z } from 'zod';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const TAG_PALETTE = {
  gray: '#6b7280',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  teal: '#14b8a6',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#ec4899',
} as const;

const paletteName = z.enum(Object.keys(TAG_PALETTE) as [keyof typeof TAG_PALETTE, ...(keyof typeof TAG_PALETTE)[]]);
// Palette names are stored as their hex value, so clients only ever see hex.
const color = z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/), paletteName.transform((n) => TAG_PALETTE[n])]).transform((c) => c.toLowerCase());
const name = z.string().trim().min(1).max(40);

export const createTagSchema = z.object({ name, color: color.default(TAG_PALETTE.gray) });
export const updateTagSchema = z.object({ name: name.optional(), color: color.optional() });
export const setContactTagsSchema = z.object({ tagIds: z.array(z.uuid()).max(20) });
export const contactIdParamSchema = z.object({ contactId: z.uuid() });
export const tagContactsQuerySchema = listQuerySchema.pick({ page: true, limit: true });

export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type TagContactsQuery = z.infer<typeof tagContactsQuerySchema>;
