import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { ForbiddenError } from '@/shared/errors/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { customFieldsService } from './custom-fields.service.js';
import type { CreateDefinitionInput, ListDefinitionsQuery, UpdateDefinitionInput } from './custom-fields.validation.js';

type IdParams = { id: string };

class CustomFieldsController {
  // Readable by anyone who can view the entity; inactive definitions only for settings managers.
  async list(req: ValidatedRequest<{ query: ListDefinitionsQuery }>, res: Response) {
    const { entityType, includeInactive } = req.validated.query;
    const { permissions } = req.auth;
    if (!permissions.includes(`${entityType}s.view`)) throw new ForbiddenError();
    const activeOnly = !(includeInactive === 'true' && permissions.includes('settings.manage'));
    sendSuccess(res, { data: await customFieldsService.list({ organizationId: req.auth.organizationId, entityType, activeOnly }) });
  }

  async create(req: ValidatedRequest<{ body: CreateDefinitionInput }>, res: Response) {
    const data = await customFieldsService.create({ organizationId: req.auth.organizationId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Custom field created', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateDefinitionInput }>, res: Response) {
    const data = await customFieldsService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Custom field updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await customFieldsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Custom field deleted' });
  }
}

export const customFieldsController = new CustomFieldsController();
