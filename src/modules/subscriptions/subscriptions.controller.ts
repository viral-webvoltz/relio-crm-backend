import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { ForbiddenError } from '@/shared/errors/index.js';
import { pageMeta, type ListQuery } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { subscriptionsService } from './subscriptions.service.js';
import type { CreateSubscriptionInput, SubscriptionListQuery, UpdateSubscriptionInput } from './subscriptions.validation.js';

type IdParams = { id: string };

class SubscriptionsController {
  async list(req: ValidatedRequest<{ query: SubscriptionListQuery }>, res: Response) {
    const { query } = req.validated;
    const { rows, total } = await subscriptionsService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await subscriptionsService.getById({ organizationId: req.auth.organizationId, id: req.validated.params.id }) });
  }

  // A subscription places orders and invoices on its own, so creating one needs those rights too.
  async create(req: ValidatedRequest<{ body: CreateSubscriptionInput }>, res: Response) {
    const { organizationId, userId, permissions } = req.auth;
    if (!permissions.includes('orders.create') || !permissions.includes('invoices.create')) throw new ForbiddenError();
    sendSuccess(res, {
      statusCode: 201,
      message: 'Subscription created',
      data: await subscriptionsService.create({ organizationId, userId, input: req.validated.body }),
    });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateSubscriptionInput }>, res: Response) {
    const data = await subscriptionsService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Subscription updated', data });
  }

  async pause(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, {
      message: 'Subscription paused',
      data: await subscriptionsService.pause({ organizationId: req.auth.organizationId, id: req.validated.params.id }),
    });
  }

  async resume(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, {
      message: 'Subscription resumed',
      data: await subscriptionsService.resume({ organizationId: req.auth.organizationId, id: req.validated.params.id }),
    });
  }

  async cancel(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, {
      message: 'Subscription cancelled',
      data: await subscriptionsService.cancel({ organizationId: req.auth.organizationId, id: req.validated.params.id }),
    });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await subscriptionsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Subscription deleted' });
  }

  async runNow(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const { organizationId, userId, permissions } = req.auth;
    if (!permissions.includes('orders.create') || !permissions.includes('invoices.create')) throw new ForbiddenError();
    const { subscription, order, invoice } = await subscriptionsService.runNow({ organizationId, userId, id: req.validated.params.id });
    sendSuccess(res, { statusCode: 201, message: 'Invoice created', data: { subscription, order, invoice } });
  }

  async runs(req: ValidatedRequest<{ params: IdParams; query: ListQuery }>, res: Response) {
    const { page, limit } = req.validated.query;
    const { rows, total } = await subscriptionsService.runs({ organizationId: req.auth.organizationId, id: req.validated.params.id, page, limit });
    sendSuccess(res, { data: rows, meta: pageMeta(req.validated.query, total) });
  }
}

export const subscriptionsController = new SubscriptionsController();
