import { BadRequestError, NotFoundError } from '@/shared/errors/index.js';
import { portalDocumentsRepository } from './portal-documents.repository.js';
import type { DocumentListQuery } from './portal-documents.validation.js';

// Path separators and control characters are dropped so the name is safe to store and to echo in headers.
// eslint-disable-next-line no-control-regex
const unsafeFileNameChars = /[\\/\u0000-\u001f\u007f]/g;

export function sanitizeFileName(raw: string) {
  return raw.replace(unsafeFileNameChars, '').trim().slice(0, 150) || 'file';
}

class PortalDocumentsService {
  async upload({
    organizationId,
    userId,
    contactId,
    name,
    fileName,
    mimeType,
    content,
  }: {
    organizationId: string;
    userId: string;
    contactId: string;
    name: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
  }) {
    if (content.length === 0) throw new BadRequestError('The file is empty', 'EMPTY_FILE');
    if (!(await portalDocumentsRepository.contactExists(organizationId, contactId))) throw new NotFoundError('Contact not found');
    const doc = await portalDocumentsRepository.insert({
      organizationId,
      contactId,
      name,
      fileName: sanitizeFileName(fileName),
      mimeType,
      sizeBytes: content.length,
      content,
      uploadedBy: userId,
    });
    if (!doc) throw new Error('Document insert returned no row');
    return doc;
  }

  list(organizationId: string, query: DocumentListQuery) {
    return portalDocumentsRepository.list(organizationId, query);
  }

  async remove(organizationId: string, id: string) {
    if (!(await portalDocumentsRepository.delete(organizationId, id))) throw new NotFoundError('Document not found');
  }
}

export const portalDocumentsService = new PortalDocumentsService();
