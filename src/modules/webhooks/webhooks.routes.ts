import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { webhooksController } from './webhooks.controller.js';
import { createEndpointSchema, deliveryParamsSchema, retryQuerySchema, updateEndpointSchema } from './webhooks.validation.js';

const router = Router();
router.use(authenticate, authorize('settings.manage'));

router.get('/', webhooksController.list);
router.post('/', validateRequest({ body: createEndpointSchema }), webhooksController.create);
router.patch('/:id', validateRequest({ params: idParamSchema, body: updateEndpointSchema }), webhooksController.update);
router.delete('/:id', validateRequest({ params: idParamSchema }), webhooksController.remove);
router.get('/:id/deliveries', validateRequest({ params: idParamSchema, query: listQuerySchema }), webhooksController.deliveries);
router.get('/:id/deliveries/:deliveryId', validateRequest({ params: deliveryParamsSchema }), webhooksController.delivery);
router.post('/:id/deliveries/:deliveryId/retry', validateRequest({ params: deliveryParamsSchema, query: retryQuerySchema }), webhooksController.retryDelivery);
router.post('/:id/rotate-secret', validateRequest({ params: idParamSchema }), webhooksController.rotateSecret);
router.post('/:id/test', validateRequest({ params: idParamSchema }), webhooksController.test);

export default router;
