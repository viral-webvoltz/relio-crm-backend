import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { contactsController } from './contacts.controller.js';
import { contactListQuerySchema, createContactSchema, updateContactSchema, batchContactsSchema } from './contacts.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', authorize('contacts.view'), validateRequest({ query: contactListQuerySchema }), contactsController.list);
router.post('/batch', authorize('contacts.update', 'contacts.delete'), validateRequest({ body: batchContactsSchema }), contactsController.batch);
router.get('/trash', authorize('contacts.delete'), validateRequest({ query: listQuerySchema }), contactsController.trash);
router.get('/:id', authorize('contacts.view'), validateRequest({ params: idParamSchema }), contactsController.get);
router.post('/', authorize('contacts.create'), idempotent, validateRequest({ body: createContactSchema }), contactsController.create);
router.patch('/:id', authorize('contacts.update'), validateRequest({ params: idParamSchema, body: updateContactSchema }), contactsController.update);
router.post('/:id/restore', authorize('contacts.delete'), validateRequest({ params: idParamSchema }), contactsController.restore);
router.delete('/:id', authorize('contacts.delete'), validateRequest({ params: idParamSchema }), contactsController.remove);

export default router;
