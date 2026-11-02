import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { activitiesController } from './activities.controller.js';
import { activityListQuerySchema, createActivitySchema, recentActivityQuerySchema, updateActivitySchema } from './activities.validation.js';

const router = Router();

router.use(authenticate);

router.get('/recent', authorize('activities.view'), validateRequest({ query: recentActivityQuerySchema }), activitiesController.listRecent);
router.get('/', authorize('activities.view'), validateRequest({ query: activityListQuerySchema }), activitiesController.list);
router.post('/', authorize('activities.create'), validateRequest({ body: createActivitySchema }), activitiesController.create);
router.patch('/:id', authorize('activities.update'), validateRequest({ params: idParamSchema, body: updateActivitySchema }), activitiesController.update);
router.delete('/:id', authorize('activities.delete'), validateRequest({ params: idParamSchema }), activitiesController.remove);

export default router;
