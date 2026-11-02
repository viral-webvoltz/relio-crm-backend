import type { Request, Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { salesService } from './sales.service.js';
import type { CreateDealInput, DealListQuery, MoveDealInput, UpdateDealInput } from './sales.validation.js';

type IdParams = { id: string };

class SalesController {
  async list(req: ValidatedRequest<{ query: DealListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await salesService.listDeals({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async board(req: Request, res: Response) {
    sendSuccess(res, { data: await salesService.getBoard({ organizationId: req.auth.organizationId }) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await salesService.getDeal({ organizationId: req.auth.organizationId, id: req.validated.params.id }) });
  }

  async create(req: ValidatedRequest<{ body: CreateDealInput }>, res: Response) {
    const deal = await salesService.createDeal({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Deal created', data: deal });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateDealInput }>, res: Response) {
    const deal = await salesService.updateDeal({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Deal updated', data: deal });
  }

  async move(req: ValidatedRequest<{ params: IdParams; body: MoveDealInput }>, res: Response) {
    const deal = await salesService.moveDeal({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      input: req.validated.body,
      actorId: req.auth.userId,
    });
    sendSuccess(res, { message: 'Deal moved', data: deal });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await salesService.deleteDeal({ organizationId: req.auth.organizationId, id: req.validated.params.id, userId: req.auth.userId });
    sendSuccess(res, { message: 'Deal deleted' });
  }

  async trash(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await salesService.listDeletedDeals({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async restore(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await salesService.restoreDeal({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Deal restored', data });
  }
}

export const salesController = new SalesController();
