import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { preferencesController } from './preferences.controller.js';
import { keyParamSchema, putPreferenceSchema } from './preferences.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', preferencesController.list);
router.put('/:key', validateRequest({ params: keyParamSchema, body: putPreferenceSchema }), preferencesController.set);

export default router;
