import { z } from 'zod';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const allowedMimeTypes = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const maxUploadBytes = '10mb';

// The file itself is the raw request body; its metadata travels in the query string.
export const uploadQuerySchema = z.object({
  contactId: z.uuid(),
  name: z.string().trim().min(1).max(150),
  fileName: z.string().max(500).optional(),
});

export const documentListQuerySchema = listQuerySchema.extend({ contactId: z.uuid().optional() });

export type UploadQuery = z.infer<typeof uploadQuerySchema>;
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
