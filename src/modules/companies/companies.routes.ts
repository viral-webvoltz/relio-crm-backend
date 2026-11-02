import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { companiesController } from './companies.controller.js';
import { createCompanySchema, updateCompanySchema, batchCompaniesSchema } from './companies.validation.js';

const router = Router();

router.use(authenticate);
router.get('/', authorize('companies.view'), validateRequest({ query: listQuerySchema }), companiesController.list);
router.post('/batch', authorize('companies.update', 'companies.delete'), validateRequest({ body: batchCompaniesSchema }), companiesController.batch);
router.get('/trash', authorize('companies.delete'), validateRequest({ query: listQuerySchema }), companiesController.trash);
router.get('/:id', authorize('companies.view'), validateRequest({ params: idParamSchema }), companiesController.get);
router.post('/', authorize('companies.create'), idempotent, validateRequest({ body: createCompanySchema }), companiesController.create);
router.patch('/:id', authorize('companies.update'), validateRequest({ params: idParamSchema, body: updateCompanySchema }), companiesController.update);
router.post('/:id/restore', authorize('companies.delete'), validateRequest({ params: idParamSchema }), companiesController.restore);
router.delete('/:id', authorize('companies.delete'), validateRequest({ params: idParamSchema }), companiesController.remove);

export default router;
