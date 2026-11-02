import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { commentsController } from './comments.controller.js';
import { commentListQuerySchema, createCommentSchema, updateCommentSchema } from './comments.validation.js';

const router = Router();

// The coarse gate lets either audience in; the service enforces the permission for the specific entity type.
router.use(authenticate);
router.get('/', authorize('deals.view', 'tickets.view'), validateRequest({ query: commentListQuerySchema }), commentsController.list);
router.post('/', authorize('deals.update', 'tickets.reply'), idempotent, validateRequest({ body: createCommentSchema }), commentsController.create);
router.patch('/:id', validateRequest({ params: idParamSchema, body: updateCommentSchema }), commentsController.update);
router.delete('/:id', validateRequest({ params: idParamSchema }), commentsController.remove);

export default router;
