import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { tasksController } from './tasks.controller.js';
import { createTaskSchema, taskListQuerySchema, updateTaskSchema, batchTasksSchema } from './tasks.validation.js';

const router = Router();

router.use(authenticate);

router.get('/', authorize('tasks.view'), validateRequest({ query: taskListQuerySchema }), tasksController.list);
router.post('/batch', authorize('tasks.update', 'tasks.delete'), validateRequest({ body: batchTasksSchema }), tasksController.batch);
router.get('/trash', authorize('tasks.delete'), validateRequest({ query: listQuerySchema }), tasksController.trash);
router.get('/:id', authorize('tasks.view'), validateRequest({ params: idParamSchema }), tasksController.get);
router.post('/', authorize('tasks.create'), idempotent, validateRequest({ body: createTaskSchema }), tasksController.create);
router.patch('/:id', authorize('tasks.update'), validateRequest({ params: idParamSchema, body: updateTaskSchema }), tasksController.update);
router.post('/:id/restore', authorize('tasks.delete'), validateRequest({ params: idParamSchema }), tasksController.restore);
router.delete('/:id', authorize('tasks.delete'), validateRequest({ params: idParamSchema }), tasksController.remove);

export default router;
