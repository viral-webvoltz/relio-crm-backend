import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { dashboardController } from './dashboard.controller.js';
import { summaryQuerySchema } from './dashboard.validation.js';

const router = Router();
router.use(authenticate);

router.get('/summary', validateRequest({ query: summaryQuerySchema }), dashboardController.summary);

export default router;
