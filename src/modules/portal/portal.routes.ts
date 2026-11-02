import { Router } from 'express';
import { authenticateCustomer } from '@/middleware/authenticate-customer.js';
import { accountRateLimit, authRateLimit } from '@/middleware/rate-limit.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { portalCreateTicketSchema, portalReplySchema } from '@/modules/support/support.validation.js';
import { portalController } from './portal.controller.js';
import { changePasswordSchema, createAppointmentSchema, customerLoginSchema, updateProfileSchema } from './portal.validation.js';

const router = Router();

router.post('/auth/login', authRateLimit, accountRateLimit, validateRequest({ body: customerLoginSchema }), portalController.login);
router.post('/auth/logout', portalController.logout);

// Everything below needs a customer session; staff sessions do not work here and vice versa.
router.use(authenticateCustomer);

router.get('/me', portalController.me);
router.patch('/me', validateRequest({ body: updateProfileSchema }), portalController.updateMe);
router.post('/me/password', authRateLimit, validateRequest({ body: changePasswordSchema }), portalController.changePassword);

router.get('/orders', validateRequest({ query: listQuerySchema }), portalController.listOrders);
router.get('/orders/:id', validateRequest({ params: idParamSchema }), portalController.getOrder);

router.get('/tickets', validateRequest({ query: listQuerySchema }), portalController.listTickets);
router.get('/tickets/:id', validateRequest({ params: idParamSchema }), portalController.getTicket);
router.post('/tickets', validateRequest({ body: portalCreateTicketSchema }), portalController.createTicket);
router.post('/tickets/:id/messages', validateRequest({ params: idParamSchema, body: portalReplySchema }), portalController.addTicketMessage);

router.get('/invoices', validateRequest({ query: listQuerySchema }), portalController.listInvoices);
router.get('/invoices/:id', validateRequest({ params: idParamSchema }), portalController.getInvoice);

router.get('/notices', validateRequest({ query: listQuerySchema }), portalController.listNotices);

router.get('/documents', validateRequest({ query: listQuerySchema }), portalController.listDocuments);
router.get('/documents/:id/download', validateRequest({ params: idParamSchema }), portalController.downloadDocument);

router.get('/appointments', validateRequest({ query: listQuerySchema }), portalController.listAppointments);
router.get('/appointments/:id', validateRequest({ params: idParamSchema }), portalController.getAppointment);
router.post('/appointments', validateRequest({ body: createAppointmentSchema }), portalController.createAppointment);
router.post('/appointments/:id/cancel', validateRequest({ params: idParamSchema }), portalController.cancelAppointment);

export default router;
