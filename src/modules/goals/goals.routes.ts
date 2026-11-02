import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { goalsController } from './goals.controller.js';
import { createGoalSchema, goalListQuerySchema, leaderboardQuerySchema, updateGoalSchema } from './goals.validation.js';

const router = Router();
router.use(authenticate);

router.get('/', authorize('goals.view'), validateRequest({ query: goalListQuerySchema }), goalsController.list);
router.get('/leaderboard', authorize('goals.view'), validateRequest({ query: leaderboardQuerySchema }), goalsController.leaderboard); // before /:id
router.get('/:id', authorize('goals.view'), validateRequest({ params: idParamSchema }), goalsController.get);
router.post('/', authorize('goals.manage'), idempotent, validateRequest({ body: createGoalSchema }), goalsController.create);
router.patch('/:id', authorize('goals.manage'), validateRequest({ params: idParamSchema, body: updateGoalSchema }), goalsController.update);
router.delete('/:id', authorize('goals.manage'), validateRequest({ params: idParamSchema }), goalsController.remove);

export default router;
