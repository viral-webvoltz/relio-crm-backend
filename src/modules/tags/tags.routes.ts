import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { tagsController } from './tags.controller.js';
import { contactIdParamSchema, createTagSchema, setContactTagsSchema, tagContactsQuerySchema, updateTagSchema } from './tags.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', authorize('contacts.view'), tagsController.list);
router.post('/', authorize('contacts.update'), idempotent, validateRequest({ body: createTagSchema }), tagsController.create);
router.get('/contacts/:contactId', authorize('contacts.view'), validateRequest({ params: contactIdParamSchema }), tagsController.forContact);
router.put(
  '/contacts/:contactId',
  authorize('contacts.update'),
  validateRequest({ params: contactIdParamSchema, body: setContactTagsSchema }),
  tagsController.setForContact,
);
router.get('/:id/contacts', authorize('contacts.view'), validateRequest({ params: idParamSchema, query: tagContactsQuerySchema }), tagsController.contacts);
router.patch('/:id', authorize('contacts.update'), validateRequest({ params: idParamSchema, body: updateTagSchema }), tagsController.update);
router.delete('/:id', authorize('contacts.update'), validateRequest({ params: idParamSchema }), tagsController.remove);

export default router;
