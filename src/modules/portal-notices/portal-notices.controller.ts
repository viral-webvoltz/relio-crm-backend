import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta, type ListQuery } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { portalNoticesService } from './portal-notices.service.js';
import type { CreateNoticeInput, UpdateNoticeInput } from './portal-notices.validation.js';

type IdParams = { id: string };

class PortalNoticesController {
  async list(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await portalNoticesService.list(req.auth.organizationId, query);
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async create(req: ValidatedRequest<{ body: CreateNoticeInput }>, res: Response) {
    const notice = await portalNoticesService.create({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Notice created', data: notice });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateNoticeInput }>, res: Response) {
    const notice = await portalNoticesService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Notice updated', data: notice });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await portalNoticesService.remove(req.auth.organizationId, req.validated.params.id);
    sendSuccess(res, { message: 'Notice deleted' });
  }
}

export const portalNoticesController = new PortalNoticesController();
