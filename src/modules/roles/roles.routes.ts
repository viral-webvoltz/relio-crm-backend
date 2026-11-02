import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { rolesController } from './roles.controller.js';
import { createRoleSchema, updateRoleSchema } from './roles.validation.js';

const router = Router();

router.use(authenticate);

// Reading roles is needed to assign them to users, so either permission is enough.
router.get('/', authorize('users.manage', 'settings.manage'), rolesController.list);
router.post('/', authorize('settings.manage'), validateRequest({ body: createRoleSchema }), rolesController.create);
router.patch('/:id', authorize('settings.manage'), validateRequest({ params: idParamSchema, body: updateRoleSchema }), rolesController.update);
router.delete('/:id', authorize('settings.manage'), validateRequest({ params: idParamSchema }), rolesController.remove);

export default router;
