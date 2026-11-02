import { z } from 'zod';

const fields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  isPublished: z.boolean(),
  expiresAt: z.coerce.date().nullable(),
};

export const createNoticeSchema = z.object({ ...fields, isPublished: fields.isPublished.default(false), expiresAt: fields.expiresAt.optional() });
export const updateNoticeSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type CreateNoticeInput = z.infer<typeof createNoticeSchema>;
export type UpdateNoticeInput = z.infer<typeof updateNoticeSchema>;
