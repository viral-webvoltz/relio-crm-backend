import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { customFieldsController } from './custom-fields.controller.js';
import { createDefinitionSchema, listDefinitionsQuerySchema, updateDefinitionSchema } from './custom-fields.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', validateRequest({ query: listDefinitionsQuerySchema }), customFieldsController.list);
router.post('/', authorize('settings.manage'), idempotent, validateRequest({ body: createDefinitionSchema }), customFieldsController.create);
router.patch('/:id', authorize('settings.manage'), validateRequest({ params: idParamSchema, body: updateDefinitionSchema }), customFieldsController.update);
router.delete('/:id', authorize('settings.manage'), validateRequest({ params: idParamSchema }), customFieldsController.remove);

export default router;
