import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { publicLinkRateLimit } from '@/middleware/rate-limit.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { quotesController } from './quotes.controller.js';
import {
  acceptQuoteSchema,
  convertQuoteSchema,
  createQuoteSchema,
  quoteListQuerySchema,
  quoteTokenParamSchema,
  rejectQuoteSchema,
  sendQuoteSchema,
  updateQuoteSchema,
} from './quotes.validation.js';

const router = Router();
router.use(authenticate);

router.get('/', authorize('quotes.view'), validateRequest({ query: quoteListQuerySchema }), quotesController.list);
router.get('/:id', authorize('quotes.view'), validateRequest({ params: idParamSchema }), quotesController.get);
router.post('/', authorize('quotes.create'), idempotent, validateRequest({ body: createQuoteSchema }), quotesController.create);
router.patch('/:id', authorize('quotes.update'), validateRequest({ params: idParamSchema, body: updateQuoteSchema }), quotesController.update);
router.delete('/:id', authorize('quotes.delete'), validateRequest({ params: idParamSchema }), quotesController.remove);
router.post('/:id/send', authorize('quotes.update'), idempotent, validateRequest({ params: idParamSchema, body: sendQuoteSchema }), quotesController.send);
router.post(
  '/:id/convert',
  authorize('quotes.convert'),
  idempotent,
  validateRequest({ params: idParamSchema, body: convertQuoteSchema }),
  quotesController.convert,
);

// The customer page, mounted at /public/quotes with no session. Only the hash of the token is stored, and a wrong token is a plain 404.
export const publicQuotesRoutes = Router();
publicQuotesRoutes.use(publicLinkRateLimit);
publicQuotesRoutes.get('/:token', validateRequest({ params: quoteTokenParamSchema }), quotesController.publicView);
publicQuotesRoutes.post('/:token/accept', validateRequest({ params: quoteTokenParamSchema, body: acceptQuoteSchema }), quotesController.publicAccept);
publicQuotesRoutes.post('/:token/reject', validateRequest({ params: quoteTokenParamSchema, body: rejectQuoteSchema }), quotesController.publicReject);

export default router;
