import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { savedViewsController } from './saved-views.controller.js';
import { createViewSchema, listViewsQuerySchema, updateViewSchema } from './saved-views.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', validateRequest({ query: listViewsQuerySchema }), savedViewsController.list);
router.post('/', idempotent, validateRequest({ body: createViewSchema }), savedViewsController.create);
router.patch('/:id', validateRequest({ params: idParamSchema, body: updateViewSchema }), savedViewsController.update);
router.delete('/:id', validateRequest({ params: idParamSchema }), savedViewsController.remove);

export default router;
