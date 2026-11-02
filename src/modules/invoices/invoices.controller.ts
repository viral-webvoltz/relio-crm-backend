import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { invoicesService } from './invoices.service.js';
import type { CreateInvoiceInput, InvoiceListQuery, RecordPaymentInput, RefundInput } from './invoices.validation.js';

type IdParams = { id: string };

class InvoicesController {
  async list(req: ValidatedRequest<{ query: InvoiceListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await invoicesService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await invoicesService.getById({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { data });
  }

  async create(req: ValidatedRequest<{ body: CreateInvoiceInput }>, res: Response) {
    const data = await invoicesService.create({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Invoice created', data });
  }

  async voidInvoice(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await invoicesService.void({ organizationId: req.auth.organizationId, userId: req.auth.userId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Invoice voided', data });
  }

  // 201 for a new payment, 200 when the same idempotency key replays an earlier one.
  async recordPayment(req: ValidatedRequest<{ params: IdParams; body: RecordPaymentInput }>, res: Response) {
    const { payment, invoice, isDuplicate } = await invoicesService.recordPayment({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      invoiceId: req.validated.params.id,
      input: req.validated.body,
    });
    sendSuccess(res, {
      statusCode: isDuplicate ? 200 : 201,
      message: isDuplicate ? 'Payment already recorded' : 'Payment recorded',
      data: { payment, invoice },
    });
  }

  async refundPayment(req: ValidatedRequest<{ params: IdParams; body: RefundInput }>, res: Response) {
    const { refund, invoice } = await invoicesService.refundPayment({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      paymentId: req.validated.params.id,
      input: req.validated.body,
    });
    sendSuccess(res, { statusCode: 201, message: 'Refund recorded', data: { refund, invoice } });
  }
}

export const invoicesController = new InvoicesController();
