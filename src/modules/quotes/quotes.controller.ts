import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import { ForbiddenError } from '@/shared/errors/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { quotesService } from './quotes.service.js';
import type {
  AcceptQuoteInput,
  ConvertQuoteInput,
  CreateQuoteInput,
  QuoteListQuery,
  RejectQuoteInput,
  SendQuoteInput,
  UpdateQuoteInput,
} from './quotes.validation.js';

type IdParams = { id: string };
type TokenParams = { token: string };

class QuotesController {
  async list(req: ValidatedRequest<{ query: QuoteListQuery }>, res: Response) {
    const { query } = req.validated;
    const { rows, total } = await quotesService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await quotesService.getById({ organizationId: req.auth.organizationId, id: req.validated.params.id }) });
  }

  async create(req: ValidatedRequest<{ body: CreateQuoteInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, { statusCode: 201, message: 'Quote created', data: await quotesService.create({ organizationId, userId, input: req.validated.body }) });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateQuoteInput }>, res: Response) {
    const data = await quotesService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Quote updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await quotesService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Quote deleted' });
  }

  async send(req: ValidatedRequest<{ params: IdParams; body: SendQuoteInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    const data = await quotesService.send({ organizationId, userId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: data.emailQueued ? 'Quote sent' : 'Quote link created', data });
  }

  async convert(req: ValidatedRequest<{ params: IdParams; body: ConvertQuoteInput }>, res: Response) {
    const { organizationId, userId, permissions } = req.auth;
    // Converting creates an order (and an invoice), so the caller needs those rights too, not just quotes.convert.
    const needsInvoice = req.validated.body.target === 'invoice';
    if (!permissions.includes('orders.create') || (needsInvoice && !permissions.includes('invoices.create'))) throw new ForbiddenError();
    const data = await quotesService.convert({ organizationId, userId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Quote converted', data });
  }

  // Public: no session, the token in the path is the credential.
  async publicView(req: ValidatedRequest<{ params: TokenParams }>, res: Response) {
    sendSuccess(res, { data: await quotesService.publicView(req.validated.params.token) });
  }

  async publicAccept(req: ValidatedRequest<{ params: TokenParams; body: AcceptQuoteInput }>, res: Response) {
    sendSuccess(res, { message: 'Quote accepted', data: await quotesService.accept(req.validated.params.token, req.validated.body) });
  }

  async publicReject(req: ValidatedRequest<{ params: TokenParams; body: RejectQuoteInput }>, res: Response) {
    sendSuccess(res, { message: 'Quote declined', data: await quotesService.reject(req.validated.params.token, req.validated.body) });
  }
}

export const quotesController = new QuotesController();
