import { z } from 'zod';
import { documentEntityTypes } from '@/database/schema/documents.js';
import { allowedMimeTypes, maxUploadBytes } from '@/modules/portal-documents/portal-documents.validation.js';

export { allowedMimeTypes, maxUploadBytes };

// The file is the raw request body; its metadata travels in the query string.
export const uploadQuerySchema = z.object({
  entityType: z.enum(documentEntityTypes),
  entityId: z.uuid(),
  name: z.string().trim().min(1).max(150),
  fileName: z.string().max(500).optional(),
});
export const versionQuerySchema = z.object({ fileName: z.string().max(500).optional() });
export const listQuerySchemaForEntity = z.object({ entityType: z.enum(documentEntityTypes), entityId: z.uuid() });
export const downloadQuerySchema = z.object({ version: z.coerce.number().int().min(1).optional() });
export const renameDocumentSchema = z.object({ name: z.string().trim().min(1).max(150) }).strict();

export type UploadQuery = z.infer<typeof uploadQuerySchema>;
export type VersionQuery = z.infer<typeof versionQuerySchema>;
export type EntityQuery = z.infer<typeof listQuerySchemaForEntity>;
export type DownloadQuery = z.infer<typeof downloadQuerySchema>;
