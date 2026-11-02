import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { contacts } from '@/database/schema/index.js';
import { portalDocuments } from '@/database/schema/portal-extras.js';
import type { DocumentListQuery } from './portal-documents.validation.js';

// Listing and insert results name their columns, so the content bytes are never loaded unless downloading.
export const documentMetaColumns = {
  id: portalDocuments.id,
  contactId: portalDocuments.contactId,
  name: portalDocuments.name,
  fileName: portalDocuments.fileName,
  mimeType: portalDocuments.mimeType,
  sizeBytes: portalDocuments.sizeBytes,
  uploadedBy: portalDocuments.uploadedBy,
  createdAt: portalDocuments.createdAt,
};

class PortalDocumentsRepository {
  async contactExists(organizationId: string, id: string) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id)));
    return Boolean(row);
  }

  async insert(values: typeof portalDocuments.$inferInsert) {
    const [row] = await db.insert(portalDocuments).values(values).returning(documentMetaColumns);
    return row;
  }

  async list(organizationId: string, { page, limit, contactId }: DocumentListQuery) {
    const where = and(eq(portalDocuments.organizationId, organizationId), contactId ? eq(portalDocuments.contactId, contactId) : undefined);
    const [rows, [total]] = await Promise.all([
      db
        .select(documentMetaColumns)
        .from(portalDocuments)
        .where(where)
        .orderBy(desc(portalDocuments.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(portalDocuments).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async delete(organizationId: string, id: string) {
    const rows = await db
      .delete(portalDocuments)
      .where(and(eq(portalDocuments.organizationId, organizationId), eq(portalDocuments.id, id)))
      .returning({ id: portalDocuments.id });
    return rows.length > 0;
  }
}

export const portalDocumentsRepository = new PortalDocumentsRepository();
