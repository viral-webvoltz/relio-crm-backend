import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { supportService } from './support.service.js';
import type { AddMessageInput, CreateTicketInput, TicketListQuery, UpdateTicketInput } from './support.validation.js';

type IdParams = { id: string };

class SupportController {
  async list(req: ValidatedRequest<{ query: TicketListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await supportService.listTickets({ organizationId: req.auth.organizationId, userId: req.auth.userId, query });
    return sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    return sendSuccess(res, { data: await supportService.getTicket(req.auth.organizationId, req.validated.params.id) });
  }

  async create(req: ValidatedRequest<{ body: CreateTicketInput }>, res: Response) {
    const ticket = await supportService.createTicket({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    return sendSuccess(res, { statusCode: 201, message: 'Ticket created', data: ticket });
  }

  async addMessage(req: ValidatedRequest<{ params: IdParams; body: AddMessageInput }>, res: Response) {
    const message = await supportService.addMessage({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      id: req.validated.params.id,
      input: req.validated.body,
    });
    return sendSuccess(res, { statusCode: 201, message: 'Message added', data: message });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateTicketInput }>, res: Response) {
    const ticket = await supportService.updateTicket({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      input: req.validated.body,
      actorId: req.auth.userId,
    });
    return sendSuccess(res, { message: 'Ticket updated', data: ticket });
  }
}

export const supportController = new SupportController();
