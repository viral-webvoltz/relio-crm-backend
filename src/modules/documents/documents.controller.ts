import type { Request, Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { BadRequestError } from '@/shared/errors/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { allowedMimeTypes, type DownloadQuery, type EntityQuery, type UploadQuery, type VersionQuery } from './documents.validation.js';
import { documentsService } from './documents.service.js';

type IdParams = { id: string };

// Only what these helpers read, so they accept plain and validated requests alike.
type Req = Pick<Request, 'auth' | 'is' | 'body'>;

const caller = (req: Req) => ({ organizationId: req.auth.organizationId, userId: req.auth.userId, permissions: req.auth.permissions });
const encodeRfc5987 = (value: string) => encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// express.raw only fills the body for allowed types, and the route rejects the rest with a 415 before this runs.
function file(req: Req) {
  const mimeType = req.is(allowedMimeTypes);
  if (!mimeType || !Buffer.isBuffer(req.body)) throw new BadRequestError('A file body is required', 'FILE_REQUIRED');
  return { mimeType, content: req.body };
}

class DocumentsController {
  async list(req: ValidatedRequest<{ query: EntityQuery }>, res: Response) {
    sendSuccess(res, { data: await documentsService.list({ caller: caller(req), ...req.validated.query }) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await documentsService.get({ caller: caller(req), id: req.validated.params.id }) });
  }

  async upload(req: ValidatedRequest<{ query: UploadQuery }>, res: Response) {
    const { name, fileName, entityType, entityId } = req.validated.query;
    const doc = await documentsService.upload({ caller: caller(req), entityType, entityId, name, fileName: fileName ?? name, ...file(req) });
    sendSuccess(res, { statusCode: 201, message: 'Document uploaded', data: doc });
  }

  async addVersion(req: ValidatedRequest<{ params: IdParams; query: VersionQuery }>, res: Response) {
    const doc = await documentsService.addVersion({
      caller: caller(req),
      id: req.validated.params.id,
      fileName: req.validated.query.fileName ?? 'file',
      ...file(req),
    });
    sendSuccess(res, { statusCode: 201, message: 'New version uploaded', data: doc });
  }

  async rename(req: ValidatedRequest<{ params: IdParams; body: { name: string } }>, res: Response) {
    sendSuccess(res, {
      message: 'Document renamed',
      data: await documentsService.rename({ caller: caller(req), id: req.validated.params.id, name: req.validated.body.name }),
    });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await documentsService.remove({ caller: caller(req), id: req.validated.params.id });
    sendSuccess(res, { message: 'Document deleted' });
  }

  async download(req: ValidatedRequest<{ params: IdParams; query: DownloadQuery }>, res: Response) {
    const doc = await documentsService.download({ caller: caller(req), id: req.validated.params.id, version: req.validated.query.version });
    res.set({
      'Content-Type': doc.mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeRfc5987(doc.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Length': String(doc.content.length),
    });
    res.end(doc.content);
  }

  async storage(req: Request, res: Response) {
    sendSuccess(res, { data: await documentsService.storageUsed(req.auth.organizationId) });
  }
}

export const documentsController = new DocumentsController();
