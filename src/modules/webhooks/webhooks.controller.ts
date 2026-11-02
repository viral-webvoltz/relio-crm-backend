import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta, type ListQuery } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { webhooksService } from './webhooks.service.js';
import type { CreateEndpointInput, DeliveryParams, RetryQuery, UpdateEndpointInput } from './webhooks.validation.js';

type IdParams = { id: string };

class WebhooksController {
  async list(req: ValidatedRequest, res: Response) {
    sendSuccess(res, { data: await webhooksService.list(req.auth.organizationId) });
  }

  async create(req: ValidatedRequest<{ body: CreateEndpointInput }>, res: Response) {
    const data = await webhooksService.create({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Webhook endpoint created. Store the secret now: it is not shown again.', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateEndpointInput }>, res: Response) {
    const data = await webhooksService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Webhook endpoint updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await webhooksService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Webhook endpoint deleted' });
  }

  async deliveries(req: ValidatedRequest<{ params: IdParams; query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await webhooksService.listDeliveries({ organizationId: req.auth.organizationId, id: req.validated.params.id, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async delivery(req: ValidatedRequest<{ params: DeliveryParams }>, res: Response) {
    const { id, deliveryId } = req.validated.params;
    sendSuccess(res, { data: await webhooksService.getDelivery({ organizationId: req.auth.organizationId, id, deliveryId }) });
  }

  async retryDelivery(req: ValidatedRequest<{ params: DeliveryParams; query: RetryQuery }>, res: Response) {
    const { id, deliveryId } = req.validated.params;
    const data = await webhooksService.retryDelivery({ organizationId: req.auth.organizationId, id, deliveryId, force: req.validated.query.force });
    sendSuccess(res, { message: 'Delivery queued for retry', data });
  }

  async rotateSecret(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await webhooksService.rotateSecret({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Secret rotated. Store the new secret now: it is not shown again. The previous secret keeps signing for 24 hours.', data });
  }

  async test(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await webhooksService.sendTest({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { statusCode: 202, message: 'Test event queued' });
  }
}

export const webhooksController = new WebhooksController();
