import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { notificationsController } from './notifications.controller.js';
import { notificationListQuerySchema } from './notifications.validation.js';

const router = Router();

// Every user sees only their own notifications, so no permission is needed beyond being signed in.
router.use(authenticate);
router.get('/', validateRequest({ query: notificationListQuerySchema }), notificationsController.list);
router.post('/read-all', notificationsController.markAllRead);
router.post('/:id/read', validateRequest({ params: idParamSchema }), notificationsController.markRead);

export default router;
