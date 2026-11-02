import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { sessionOnly } from '@/middleware/session-only.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { authController } from '@/modules/auth/auth.controller.js';
import { usersController } from './users.controller.js';
import { createUserSchema, updateUserSchema } from './users.validation.js';

const router = Router();

router.use(authenticate);

router.get('/options', usersController.listOptions);
router.get('/', authorize('users.manage'), usersController.list);
router.post('/', authorize('users.manage'), validateRequest({ body: createUserSchema }), usersController.create);
router.post('/:id/two-factor/reset', sessionOnly, authorize('users.manage'), validateRequest({ params: idParamSchema }), authController.twoFactorAdminReset);
router.patch('/:id', authorize('users.manage'), validateRequest({ params: idParamSchema, body: updateUserSchema }), usersController.update);

export default router;
