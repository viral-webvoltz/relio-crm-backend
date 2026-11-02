import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { subscriptionsController } from './subscriptions.controller.js';
import { createSubscriptionSchema, subscriptionListQuerySchema, updateSubscriptionSchema } from './subscriptions.validation.js';

const router = Router();
router.use(authenticate);

const id = validateRequest({ params: idParamSchema });

router.get('/', authorize('subscriptions.view'), validateRequest({ query: subscriptionListQuerySchema }), subscriptionsController.list);
router.get('/:id', authorize('subscriptions.view'), id, subscriptionsController.get);
router.get('/:id/runs', authorize('subscriptions.view'), validateRequest({ params: idParamSchema, query: listQuerySchema }), subscriptionsController.runs);
router.post('/', authorize('subscriptions.create'), idempotent, validateRequest({ body: createSubscriptionSchema }), subscriptionsController.create);
router.patch(
  '/:id',
  authorize('subscriptions.update'),
  validateRequest({ params: idParamSchema, body: updateSubscriptionSchema }),
  subscriptionsController.update,
);
router.delete('/:id', authorize('subscriptions.delete'), id, subscriptionsController.remove);
router.post('/:id/pause', authorize('subscriptions.update'), id, subscriptionsController.pause);
router.post('/:id/resume', authorize('subscriptions.update'), id, subscriptionsController.resume);
router.post('/:id/cancel', authorize('subscriptions.update'), id, subscriptionsController.cancel);
router.post('/:id/run', authorize('subscriptions.update'), idempotent, id, subscriptionsController.runNow);

export default router;
