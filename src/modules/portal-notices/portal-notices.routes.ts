import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { portalNoticesController } from './portal-notices.controller.js';
import { createNoticeSchema, updateNoticeSchema } from './portal-notices.validation.js';

const router = Router();

router.use(authenticate, authorize('portal.manage'));
router.get('/', validateRequest({ query: listQuerySchema }), portalNoticesController.list);
router.post('/', idempotent, validateRequest({ body: createNoticeSchema }), portalNoticesController.create);
router.patch('/:id', validateRequest({ params: idParamSchema, body: updateNoticeSchema }), portalNoticesController.update);
router.delete('/:id', validateRequest({ params: idParamSchema }), portalNoticesController.remove);

export default router;
