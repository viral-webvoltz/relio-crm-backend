import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { slaController } from './sla.controller.js';
import { slaPolicySchema, slaSummaryQuerySchema } from './sla.validation.js';
import { supportController } from './support.controller.js';
import { addMessageSchema, createTicketSchema, ticketListQuerySchema, updateTicketSchema } from './support.validation.js';

const router = Router();

router.use(authenticate);

router.get('/', authorize('tickets.view'), validateRequest({ query: ticketListQuerySchema }), supportController.list);
// SLA routes come before /:id so "sla" is never read as a ticket id.
router.get('/sla/policy', authorize('tickets.view'), slaController.getPolicy);
router.put('/sla/policy', authorize('settings.manage'), validateRequest({ body: slaPolicySchema }), slaController.putPolicy);
router.get('/sla/summary', authorize('tickets.view'), validateRequest({ query: slaSummaryQuerySchema }), slaController.summary);
router.get('/:id', authorize('tickets.view'), validateRequest({ params: idParamSchema }), supportController.get);
router.post('/', authorize('tickets.create'), idempotent, validateRequest({ body: createTicketSchema }), supportController.create);
router.post('/:id/messages', authorize('tickets.reply'), validateRequest({ params: idParamSchema, body: addMessageSchema }), supportController.addMessage);
router.patch('/:id', authorize('tickets.update'), validateRequest({ params: idParamSchema, body: updateTicketSchema }), supportController.update);

export default router;
