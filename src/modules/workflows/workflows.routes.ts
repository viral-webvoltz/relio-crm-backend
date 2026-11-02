import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { workflowsController } from './workflows.controller.js';
import { createWorkflowSchema, settingsSchema, testWorkflowSchema, updateWorkflowSchema } from './workflows.validation.js';

const router = Router();
router.use(authenticate, authorize('settings.manage'));

router.get('/', workflowsController.list);
router.get('/meta', workflowsController.meta);
router.get('/queue', workflowsController.queue);
router.get('/settings', workflowsController.settings);
router.patch('/settings', validateRequest({ body: settingsSchema }), workflowsController.updateSettings);
router.post('/', validateRequest({ body: createWorkflowSchema }), workflowsController.create);
router.patch('/:id', validateRequest({ params: idParamSchema, body: updateWorkflowSchema }), workflowsController.update);
router.delete('/:id', validateRequest({ params: idParamSchema }), workflowsController.remove);
router.post('/:id/test', validateRequest({ params: idParamSchema, body: testWorkflowSchema }), workflowsController.test);
router.get('/:id/runs', validateRequest({ params: idParamSchema, query: listQuerySchema }), workflowsController.runs);

export default router;
