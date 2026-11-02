import { and, desc, eq, sql } from 'drizzle-orm';
import { db, withTransaction } from '@/config/database.js';
import { documents, documentVersions, users, type DocumentEntityType } from '@/database/schema/index.js';
import { sanitizeFileName } from '@/modules/portal-documents/portal-documents.service.js';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { entityExists, viewPermission } from './documents.entities.js';

const MAX_VERSIONS = 50;
export const ORG_STORAGE_BYTES = 1024 * 1024 * 1024; // 1 GiB of documents per organization

type Caller = { organizationId: string; userId: string; permissions: readonly string[] };

const versionMeta = {
  version: documentVersions.version,
  fileName: documentVersions.fileName,
  mimeType: documentVersions.mimeType,
  sizeBytes: documentVersions.sizeBytes,
  uploadedBy: documentVersions.uploadedBy,
  uploadedByName: users.fullName,
  createdAt: documentVersions.createdAt,
};

class DocumentsService {
  // The documents of one record (with their latest version), newest first.
  async list({ caller, entityType, entityId }: { caller: Caller; entityType: DocumentEntityType; entityId: string }) {
    this.mayView(caller, entityType);
    return db
      .select({
        id: documents.id,
        name: documents.name,
        entityType: documents.entityType,
        entityId: documents.entityId,
        currentVersion: documents.currentVersion,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        fileName: documentVersions.fileName,
        mimeType: documentVersions.mimeType,
        sizeBytes: documentVersions.sizeBytes,
        uploadedByName: users.fullName,
      })
      .from(documents)
      .innerJoin(documentVersions, and(eq(documentVersions.documentId, documents.id), eq(documentVersions.version, documents.currentVersion)))
      .leftJoin(users, eq(users.id, documentVersions.uploadedBy))
      .where(and(eq(documents.organizationId, caller.organizationId), eq(documents.entityType, entityType), eq(documents.entityId, entityId)))
      .orderBy(desc(documents.createdAt));
  }

  async get({ caller, id }: { caller: Caller; id: string }) {
    const doc = await this.find(caller, id);
    const versions = await db
      .select(versionMeta)
      .from(documentVersions)
      .leftJoin(users, eq(users.id, documentVersions.uploadedBy))
      .where(eq(documentVersions.documentId, id))
      .orderBy(desc(documentVersions.version));
    return { ...doc, versions };
  }

  async upload({
    caller,
    entityType,
    entityId,
    name,
    fileName,
    mimeType,
    content,
  }: {
    caller: Caller;
    entityType: DocumentEntityType;
    entityId: string;
    name: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
  }) {
    this.mayView(caller, entityType); // you can only attach to what you can see
    if (content.length === 0) throw new BadRequestError('The file is empty', 'EMPTY_FILE');
    if (!(await entityExists(caller.organizationId, entityType, entityId))) throw new NotFoundError('The record to attach to was not found');

    return withTransaction(async (tx) => {
      await this.assertRoom(tx, caller.organizationId, content.length);
      const [doc] = await tx
        .insert(documents)
        .values({ organizationId: caller.organizationId, entityType, entityId, name, createdBy: caller.userId })
        .returning();
      await tx.insert(documentVersions).values({
        organizationId: caller.organizationId,
        documentId: doc!.id,
        version: 1,
        fileName: sanitizeFileName(fileName),
        mimeType,
        sizeBytes: content.length,
        content,
        uploadedBy: caller.userId,
      });
      await audit(
        {
          organizationId: caller.organizationId,
          actorUserId: caller.userId,
          action: 'document.uploaded',
          targetType: entityType,
          targetId: entityId,
          metadata: { documentId: doc!.id, name },
        },
        tx,
      );
      return doc!;
    });
  }

  // A new version replaces the file for everyone from now on; the older ones stay downloadable.
  async addVersion({ caller, id, fileName, mimeType, content }: { caller: Caller; id: string; fileName: string; mimeType: string; content: Buffer }) {
    if (content.length === 0) throw new BadRequestError('The file is empty', 'EMPTY_FILE');
    await this.find(caller, id);
    return withTransaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.organizationId, caller.organizationId), eq(documents.id, id)))
        .for('update');
      if (!doc) throw new NotFoundError('Document not found');
      if (doc.currentVersion >= MAX_VERSIONS) throw new ConflictError(`A document can have at most ${MAX_VERSIONS} versions`, 'TOO_MANY_VERSIONS');
      await this.assertRoom(tx, caller.organizationId, content.length);
      const version = doc.currentVersion + 1;
      await tx.insert(documentVersions).values({
        organizationId: caller.organizationId,
        documentId: id,
        version,
        fileName: sanitizeFileName(fileName),
        mimeType,
        sizeBytes: content.length,
        content,
        uploadedBy: caller.userId,
      });
      const [updated] = await tx.update(documents).set({ currentVersion: version, updatedAt: new Date() }).where(eq(documents.id, id)).returning();
      await audit(
        {
          organizationId: caller.organizationId,
          actorUserId: caller.userId,
          action: 'document.version_added',
          targetType: doc.entityType,
          targetId: doc.entityId,
          metadata: { documentId: id, version },
        },
        tx,
      );
      return updated!;
    });
  }

  async rename({ caller, id, name }: { caller: Caller; id: string; name: string }) {
    await this.find(caller, id);
    const [doc] = await db
      .update(documents)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(documents.organizationId, caller.organizationId), eq(documents.id, id)))
      .returning();
    return doc!;
  }

  async remove({ caller, id }: { caller: Caller; id: string }) {
    const doc = await this.find(caller, id);
    await db.delete(documents).where(eq(documents.id, id)); // its versions go with it
    await audit({
      organizationId: caller.organizationId,
      actorUserId: caller.userId,
      action: 'document.deleted',
      targetType: doc.entityType,
      targetId: doc.entityId,
      metadata: { documentId: id, name: doc.name },
    });
  }

  // The bytes of one version (the latest unless asked otherwise).
  async download({ caller, id, version }: { caller: Caller; id: string; version?: number | undefined }) {
    const doc = await this.find(caller, id);
    const [file] = await db
      .select({ fileName: documentVersions.fileName, mimeType: documentVersions.mimeType, content: documentVersions.content })
      .from(documentVersions)
      .where(and(eq(documentVersions.documentId, id), eq(documentVersions.version, version ?? doc.currentVersion)));
    if (!file) throw new NotFoundError('Version not found');
    return file;
  }

  async storageUsed(organizationId: string) {
    const [row] = await db
      .select({ bytes: sql<number>`coalesce(sum(${documentVersions.sizeBytes}), 0)`.mapWith(Number) })
      .from(documentVersions)
      .where(eq(documentVersions.organizationId, organizationId));
    return { usedBytes: row?.bytes ?? 0, limitBytes: ORG_STORAGE_BYTES };
  }

  // ---- helpers ----

  private mayView(caller: Caller, type: DocumentEntityType) {
    if (!caller.permissions.includes(viewPermission(type))) throw new ForbiddenError();
  }

  // 404 for a document of another organization; 403 when the caller cannot see the record it is attached to.
  private async find(caller: Caller, id: string) {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.organizationId, caller.organizationId), eq(documents.id, id)));
    if (!doc) throw new NotFoundError('Document not found');
    this.mayView(caller, doc.entityType as DocumentEntityType);
    return doc;
  }

  private async assertRoom(tx: Parameters<Parameters<typeof withTransaction>[0]>[0], organizationId: string, adding: number) {
    const [row] = await tx
      .select({ bytes: sql<number>`coalesce(sum(${documentVersions.sizeBytes}), 0)`.mapWith(Number) })
      .from(documentVersions)
      .where(eq(documentVersions.organizationId, organizationId));
    if ((row?.bytes ?? 0) + adding > ORG_STORAGE_BYTES) throw new AppError('Your document storage is full', 413, 'STORAGE_FULL');
  }
}

export const documentsService = new DocumentsService();
