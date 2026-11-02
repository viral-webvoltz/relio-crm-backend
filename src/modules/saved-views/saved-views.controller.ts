import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { savedViewsService } from './saved-views.service.js';
import type { CreateViewInput, ListViewsQuery, UpdateViewInput } from './saved-views.validation.js';

type IdParams = { id: string };

class SavedViewsController {
  async list(req: ValidatedRequest<{ query: ListViewsQuery }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, { data: await savedViewsService.list({ organizationId, userId, resource: req.validated.query.resource }) });
  }

  async create(req: ValidatedRequest<{ body: CreateViewInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    const data = await savedViewsService.create({ organizationId, userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'View saved', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateViewInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    const data = await savedViewsService.update({ organizationId, userId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'View updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const { organizationId, userId } = req.auth;
    await savedViewsService.remove({ organizationId, userId, id: req.validated.params.id });
    sendSuccess(res, { message: 'View deleted' });
  }
}

export const savedViewsController = new SavedViewsController();
