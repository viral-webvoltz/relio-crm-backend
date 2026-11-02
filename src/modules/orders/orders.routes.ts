import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { ordersController } from './orders.controller.js';
import { changeStatusSchema, createOrderSchema, orderListQuerySchema } from './orders.validation.js';

const router = Router();

router.use(authenticate);

router.get('/', authorize('orders.view'), validateRequest({ query: orderListQuerySchema }), ordersController.list);
router.get('/:id', authorize('orders.view'), validateRequest({ params: idParamSchema }), ordersController.get);
router.post('/', authorize('orders.create'), idempotent, validateRequest({ body: createOrderSchema }), ordersController.create);
router.post('/:id/status', authorize('orders.update'), validateRequest({ params: idParamSchema, body: changeStatusSchema }), ordersController.changeStatus);

export default router;
