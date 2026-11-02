import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { customersController } from './customers.controller.js';
import { contactIdParamSchema, createAccountSchema, updateAccountSchema } from './customers.validation.js';

// Staff-side management of a contact's customer-portal login.
const router = Router();

router.use(authenticate, authorize('portal.manage'));

router.get('/:contactId/account', validateRequest({ params: contactIdParamSchema }), customersController.getAccount);
router.post('/:contactId/account', validateRequest({ params: contactIdParamSchema, body: createAccountSchema }), customersController.createAccount);
router.patch('/:contactId/account', validateRequest({ params: contactIdParamSchema, body: updateAccountSchema }), customersController.updateAccount);

export default router;
