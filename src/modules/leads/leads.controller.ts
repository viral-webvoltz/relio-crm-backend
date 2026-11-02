import type { Response } from 'express';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { assertBatchPermission } from '@/shared/batch/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { leadsService } from './leads.service.js';
import type { CreateLeadInput, LeadListQuery, UpdateLeadInput, BatchLeadsInput } from './leads.validation.js';

type IdParams = { id: string };

class LeadsController {
  async list(req: ValidatedRequest<{ query: LeadListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await leadsService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await leadsService.get({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { data });
  }

  async create(req: ValidatedRequest<{ body: CreateLeadInput }>, res: Response) {
    const data = await leadsService.create({
      organizationId: req.auth.organizationId,
      input: req.validated.body,
      canAssign: req.auth.permissions.includes('leads.assign'),
    });
    sendSuccess(res, { statusCode: 201, message: 'Lead created', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateLeadInput }>, res: Response) {
    const data = await leadsService.update({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      input: req.validated.body,
      canAssign: req.auth.permissions.includes('leads.assign'),
    });
    sendSuccess(res, { message: 'Lead updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await leadsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id, userId: req.auth.userId });
    sendSuccess(res, { message: 'Lead deleted' });
  }

  async trash(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await leadsService.listDeleted({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async restore(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await leadsService.restore({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Lead restored', data });
  }

  async convert(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await leadsService.convert({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Lead converted', data });
  }

  async batch(req: ValidatedRequest<{ body: BatchLeadsInput }>, res: Response) {
    const input = req.validated.body;
    assertBatchPermission(req.auth, input.action === 'delete' ? 'leads.delete' : 'leads.update');
    sendSuccess(res, {
      data: await leadsService.batch({
        organizationId: req.auth.organizationId,
        userId: req.auth.userId,
        input,
        canAssign: req.auth.permissions.includes('leads.assign'),
      }),
    });
  }
}

export const leadsController = new LeadsController();
