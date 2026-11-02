import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { salesController } from './sales.controller.js';
import { createDealSchema, dealListQuerySchema, moveDealSchema, updateDealSchema } from './sales.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', authorize('deals.view'), validateRequest({ query: dealListQuerySchema }), salesController.list);
router.get('/board', authorize('deals.view'), salesController.board);
router.get('/trash', authorize('deals.delete'), validateRequest({ query: listQuerySchema }), salesController.trash);
router.get('/:id', authorize('deals.view'), validateRequest({ params: idParamSchema }), salesController.get);
router.post('/', authorize('deals.create'), idempotent, validateRequest({ body: createDealSchema }), salesController.create);
router.patch('/:id', authorize('deals.update'), validateRequest({ params: idParamSchema, body: updateDealSchema }), salesController.update);
router.patch('/:id/stage', authorize('deals.update'), validateRequest({ params: idParamSchema, body: moveDealSchema }), salesController.move);
router.post('/:id/restore', authorize('deals.delete'), validateRequest({ params: idParamSchema }), salesController.restore);
router.delete('/:id', authorize('deals.delete'), validateRequest({ params: idParamSchema }), salesController.remove);

export default router;
