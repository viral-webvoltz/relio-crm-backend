import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { reportsController } from './reports.controller.js';
import { createSavedSchema, createScheduleSchema, reportQuerySchema, updateSavedSchema, updateScheduleSchema } from './reports.validation.js';

const router = Router();
router.use(authenticate);

router.get('/revenue-by-month', authorize('invoices.view'), validateRequest({ query: reportQuerySchema }), reportsController.revenueByMonth);
router.get('/pipeline-velocity', authorize('deals.view'), validateRequest({ query: reportQuerySchema }), reportsController.pipelineVelocity);
router.get('/leads-funnel', authorize('leads.view'), validateRequest({ query: reportQuerySchema }), reportsController.leadsFunnel);

// Fixed prefixes first; none of these are shadowed by a /:param route.
router.get('/saved', reportsController.listSaved);
router.post('/saved', idempotent, validateRequest({ body: createSavedSchema }), reportsController.createSaved);
router.get('/saved/:id/run', validateRequest({ params: idParamSchema }), reportsController.runSaved);
router.patch('/saved/:id', validateRequest({ params: idParamSchema, body: updateSavedSchema }), reportsController.updateSaved);
router.delete('/saved/:id', validateRequest({ params: idParamSchema }), reportsController.removeSaved);

router.get('/schedules', reportsController.listSchedules);
router.post('/schedules', idempotent, validateRequest({ body: createScheduleSchema }), reportsController.createSchedule);
router.patch('/schedules/:id', validateRequest({ params: idParamSchema, body: updateScheduleSchema }), reportsController.updateSchedule);
router.delete('/schedules/:id', validateRequest({ params: idParamSchema }), reportsController.removeSchedule);

export default router;
