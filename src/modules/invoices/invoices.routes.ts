import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { invoicesController } from './invoices.controller.js';
import { createInvoiceSchema, invoiceListQuerySchema, recordPaymentSchema, refundSchema } from './invoices.validation.js';

const router = Router();
router.use(authenticate);

router.get('/', authorize('invoices.view'), validateRequest({ query: invoiceListQuerySchema }), invoicesController.list);
router.get('/:id', authorize('invoices.view'), validateRequest({ params: idParamSchema }), invoicesController.get);
router.post('/', authorize('invoices.create'), idempotent, validateRequest({ body: createInvoiceSchema }), invoicesController.create);
router.post('/:id/void', authorize('invoices.void'), validateRequest({ params: idParamSchema }), invoicesController.voidInvoice);
router.post(
  '/:id/payments',
  authorize('payments.create'),
  idempotent,
  validateRequest({ params: idParamSchema, body: recordPaymentSchema }),
  invoicesController.recordPayment,
);

export const paymentsRoutes = Router();
paymentsRoutes.use(authenticate);
paymentsRoutes.post(
  '/:id/refunds',
  authorize('payments.refund'),
  idempotent,
  validateRequest({ params: idParamSchema, body: refundSchema }),
  invoicesController.refundPayment,
);

export default router;
