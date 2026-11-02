import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { auditController } from './audit.controller.js';
import { auditListQuerySchema } from './audit.validation.js';

const router = Router();

// Reading the log is an administrator action.
router.use(authenticate, authorize('settings.manage'));
router.get('/', validateRequest({ query: auditListQuerySchema }), auditController.list);

export default router;
