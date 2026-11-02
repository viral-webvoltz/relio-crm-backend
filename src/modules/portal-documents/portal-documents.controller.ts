import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { BadRequestError } from '@/shared/errors/index.js';
import { pageMeta } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { portalDocumentsService } from './portal-documents.service.js';
import { allowedMimeTypes, type DocumentListQuery, type UploadQuery } from './portal-documents.validation.js';

type IdParams = { id: string };

class PortalDocumentsController {
  async upload(req: ValidatedRequest<{ query: UploadQuery }>, res: Response) {
    // express.raw only fills the body for allowed types, and the route rejects the rest with a 415 before this runs.
    const mimeType = req.is(allowedMimeTypes);
    if (!mimeType || !Buffer.isBuffer(req.body)) throw new BadRequestError('A file body is required', 'FILE_REQUIRED');
    const { contactId, name, fileName } = req.validated.query;
    const doc = await portalDocumentsService.upload({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      contactId,
      name,
      fileName: fileName ?? name,
      mimeType,
      content: req.body,
    });
    sendSuccess(res, { statusCode: 201, message: 'Document uploaded', data: doc });
  }

  async list(req: ValidatedRequest<{ query: DocumentListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await portalDocumentsService.list(req.auth.organizationId, query);
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await portalDocumentsService.remove(req.auth.organizationId, req.validated.params.id);
    sendSuccess(res, { message: 'Document deleted' });
  }
}

export const portalDocumentsController = new PortalDocumentsController();
