import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { productsController } from './products.controller.js';
import {
  adjustStockSchema,
  categorySchema,
  createProductSchema,
  productListQuerySchema,
  updateProductSchema,
  batchProductsSchema,
} from './products.validation.js';

const router = Router();
export const productCategoriesRoutes = Router();

router.use(authenticate);
productCategoriesRoutes.use(authenticate);

router.get('/', authorize('products.view'), validateRequest({ query: productListQuerySchema }), productsController.list);
router.post('/batch', authorize('products.update', 'products.delete'), validateRequest({ body: batchProductsSchema }), productsController.batch);
router.get('/trash', authorize('products.delete'), validateRequest({ query: listQuerySchema }), productsController.trash);
router.get('/:id', authorize('products.view'), validateRequest({ params: idParamSchema }), productsController.get);
router.post('/', authorize('products.create'), idempotent, validateRequest({ body: createProductSchema }), productsController.create);
router.patch('/:id', authorize('products.update'), validateRequest({ params: idParamSchema, body: updateProductSchema }), productsController.update);
router.post('/:id/restore', authorize('products.delete'), validateRequest({ params: idParamSchema }), productsController.restore);
router.delete('/:id', authorize('products.delete'), validateRequest({ params: idParamSchema }), productsController.remove);
router.get('/:id/movements', authorize('products.view'), validateRequest({ params: idParamSchema }), productsController.listMovements);
router.post('/:id/stock', authorize('products.stock'), validateRequest({ params: idParamSchema, body: adjustStockSchema }), productsController.adjustStock);

productCategoriesRoutes.get('/', authorize('products.view'), productsController.listCategories);
productCategoriesRoutes.post('/', authorize('products.update'), validateRequest({ body: categorySchema }), productsController.createCategory);
productCategoriesRoutes.patch(
  '/:id',
  authorize('products.update'),
  validateRequest({ params: idParamSchema, body: categorySchema }),
  productsController.renameCategory,
);
productCategoriesRoutes.delete('/:id', authorize('products.update'), validateRequest({ params: idParamSchema }), productsController.removeCategory);

export default router;
