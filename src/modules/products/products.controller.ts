import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { assertBatchPermission } from '@/shared/batch/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { productsService } from './products.service.js';
import type { AdjustStockInput, CategoryInput, CreateProductInput, ProductListQuery, UpdateProductInput, BatchProductsInput } from './products.validation.js';

type IdParams = { params: { id: string } };

class ProductsController {
  async list(req: ValidatedRequest<{ query: ProductListQuery }>, res: Response) {
    const { query } = req.validated;
    const { rows, total } = await productsService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<IdParams>, res: Response) {
    const data = await productsService.getById({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { data });
  }

  async create(req: ValidatedRequest<{ body: CreateProductInput }>, res: Response) {
    const product = await productsService.create({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Product created', data: product });
  }

  async update(req: ValidatedRequest<IdParams & { body: UpdateProductInput }>, res: Response) {
    const product = await productsService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Product updated', data: product });
  }

  async remove(req: ValidatedRequest<IdParams>, res: Response) {
    await productsService.delete({ organizationId: req.auth.organizationId, id: req.validated.params.id, userId: req.auth.userId });
    sendSuccess(res, { message: 'Product deleted' });
  }

  async trash(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const { query } = req.validated;
    const { rows, total } = await productsService.listDeleted({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async restore(req: ValidatedRequest<IdParams>, res: Response) {
    const data = await productsService.restore({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Product restored', data });
  }

  async listMovements(req: ValidatedRequest<IdParams>, res: Response) {
    const data = await productsService.listMovements({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { data });
  }

  async adjustStock(req: ValidatedRequest<IdParams & { body: AdjustStockInput }>, res: Response) {
    const product = await productsService.adjustStock({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      id: req.validated.params.id,
      input: req.validated.body,
    });
    sendSuccess(res, { message: 'Stock adjusted', data: product });
  }

  async listCategories(req: ValidatedRequest, res: Response) {
    const data = await productsService.listCategories({ organizationId: req.auth.organizationId });
    sendSuccess(res, { data });
  }

  async createCategory(req: ValidatedRequest<{ body: CategoryInput }>, res: Response) {
    const category = await productsService.createCategory({ organizationId: req.auth.organizationId, name: req.validated.body.name });
    sendSuccess(res, { statusCode: 201, message: 'Category created', data: category });
  }

  async renameCategory(req: ValidatedRequest<IdParams & { body: CategoryInput }>, res: Response) {
    const category = await productsService.renameCategory({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      name: req.validated.body.name,
    });
    sendSuccess(res, { message: 'Category updated', data: category });
  }

  async removeCategory(req: ValidatedRequest<IdParams>, res: Response) {
    await productsService.deleteCategory({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Category deleted' });
  }

  async batch(req: ValidatedRequest<{ body: BatchProductsInput }>, res: Response) {
    const input = req.validated.body;
    assertBatchPermission(req.auth, input.action === 'delete' ? 'products.delete' : 'products.update');
    sendSuccess(res, { data: await productsService.batch({ organizationId: req.auth.organizationId, userId: req.auth.userId, input }) });
  }
}

export const productsController = new ProductsController();
