import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { appointmentsController } from './appointments.controller.js';
import { appointmentListQuerySchema, updateAppointmentSchema } from './appointments.validation.js';

const router = Router();

router.use(authenticate, authorize('portal.manage'));
router.get('/', validateRequest({ query: appointmentListQuerySchema }), appointmentsController.list);
router.get('/:id', validateRequest({ params: idParamSchema }), appointmentsController.get);
router.patch('/:id', validateRequest({ params: idParamSchema, body: updateAppointmentSchema }), appointmentsController.update);

export default router;
