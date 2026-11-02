import type { Response } from 'express';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { assertBatchPermission } from '@/shared/batch/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { companiesService } from './companies.service.js';
import type { CreateCompanyInput, UpdateCompanyInput, BatchCompaniesInput } from './companies.validation.js';

type IdParams = { id: string };

class CompaniesController {
  async list(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await companiesService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await companiesService.get({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { data });
  }

  async create(req: ValidatedRequest<{ body: CreateCompanyInput }>, res: Response) {
    const data = await companiesService.create({ organizationId: req.auth.organizationId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Company created', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateCompanyInput }>, res: Response) {
    const data = await companiesService.update({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      input: req.validated.body,
    });
    sendSuccess(res, { message: 'Company updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await companiesService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id, userId: req.auth.userId });
    sendSuccess(res, { message: 'Company deleted' });
  }

  async trash(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await companiesService.listDeleted({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async restore(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await companiesService.restore({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Company restored', data });
  }

  async batch(req: ValidatedRequest<{ body: BatchCompaniesInput }>, res: Response) {
    const input = req.validated.body;
    assertBatchPermission(req.auth, input.action === 'delete' ? 'companies.delete' : 'companies.update');
    sendSuccess(res, { data: await companiesService.batch({ organizationId: req.auth.organizationId, userId: req.auth.userId, input }) });
  }
}

export const companiesController = new CompaniesController();
