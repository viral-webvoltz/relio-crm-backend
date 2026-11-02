import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { leadsController } from './leads.controller.js';
import { createLeadSchema, leadListQuerySchema, updateLeadSchema, batchLeadsSchema } from './leads.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', authorize('leads.view'), validateRequest({ query: leadListQuerySchema }), leadsController.list);
router.post('/batch', authorize('leads.update', 'leads.delete'), validateRequest({ body: batchLeadsSchema }), leadsController.batch);
router.get('/trash', authorize('leads.delete'), validateRequest({ query: listQuerySchema }), leadsController.trash);
router.get('/:id', authorize('leads.view'), validateRequest({ params: idParamSchema }), leadsController.get);
router.post('/', authorize('leads.create'), idempotent, validateRequest({ body: createLeadSchema }), leadsController.create);
router.patch('/:id', authorize('leads.update'), validateRequest({ params: idParamSchema, body: updateLeadSchema }), leadsController.update);
router.post('/:id/convert', authorize('leads.convert'), validateRequest({ params: idParamSchema }), leadsController.convert);
router.post('/:id/restore', authorize('leads.delete'), validateRequest({ params: idParamSchema }), leadsController.restore);
router.delete('/:id', authorize('leads.delete'), validateRequest({ params: idParamSchema }), leadsController.remove);

export default router;
