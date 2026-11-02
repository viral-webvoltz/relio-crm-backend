import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { ordersService } from './orders.service.js';
import type { ChangeStatusInput, CreateOrderInput, OrderListQuery } from './orders.validation.js';

class OrdersController {
  async list(req: ValidatedRequest<{ query: OrderListQuery }>, res: Response) {
    const { query } = req.validated;
    const { rows, total } = await ordersService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: { id: string } }>, res: Response) {
    const data = await ordersService.getById({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { data });
  }

  async create(req: ValidatedRequest<{ body: CreateOrderInput }>, res: Response) {
    const order = await ordersService.create({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Order placed', data: order });
  }

  async changeStatus(req: ValidatedRequest<{ params: { id: string }; body: ChangeStatusInput }>, res: Response) {
    const order = await ordersService.changeStatus({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      id: req.validated.params.id,
      input: req.validated.body,
    });
    sendSuccess(res, { message: 'Order updated', data: order });
  }
}

export const ordersController = new OrdersController();
