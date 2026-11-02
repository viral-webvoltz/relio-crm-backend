import { withTransaction } from '@/config/database.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { productsRepository } from './products.repository.js';
import type { AdjustStockInput, CreateProductInput, ProductListQuery, UpdateProductInput, BatchProductsInput } from './products.validation.js';
import { runBatch } from '@/shared/batch/index.js';

class ProductsService {
  list({ organizationId, query }: { organizationId: string; query: ProductListQuery }) {
    return productsRepository.list({ organizationId, query });
  }

  async getById({ organizationId, id }: { organizationId: string; id: string }) {
    const product = await productsRepository.findById({ organizationId, id });
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }

  async create({ organizationId, userId, input: { initialStock, ...input } }: { organizationId: string; userId: string; input: CreateProductInput }) {
    await this.assertReferences({ organizationId, input });
    return withTransaction(async (tx) => {
      const stock = input.trackInventory ? initialStock : 0;
      const product = await productsRepository.insert({ ...input, organizationId, stockQuantity: stock }, tx);
      if (stock > 0) {
        await productsRepository.insertStockMovement(
          { organizationId, productId: product.id, delta: stock, balanceAfter: stock, reason: 'Initial stock', createdBy: userId },
          tx,
        );
      }
      return product;
    });
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateProductInput }) {
    await this.assertReferences({ organizationId, input, selfId: id });
    const product = await productsRepository.update({ organizationId, id, changes: input });
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }

  // Soft delete keeps the row, so order history stays intact and products on orders can be deleted (no PRODUCT_HAS_ORDERS check needed).
  async delete({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }) {
    if (!(await productsRepository.delete({ organizationId, id, userId }))) throw new NotFoundError('Product not found');
  }

  listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }) {
    return productsRepository.listDeleted({ organizationId, query });
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }) {
    const product = await productsRepository.restore({ organizationId, id }).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictError('Product can no longer be restored: its SKU is used by another product', 'RESTORE_CONFLICT');
      throw error;
    });
    if (!product) throw new NotFoundError('Deleted product not found');
    return product;
  }

  // The conditional UPDATE is atomic: concurrent adjustments cannot push stock below zero or lose a change.
  adjustStock({ organizationId, userId, id, input: { delta, reason } }: { organizationId: string; userId: string; id: string; input: AdjustStockInput }) {
    return withTransaction(async (tx) => {
      const updated = await productsRepository.adjustStockIfAllowed({ organizationId, id, delta }, tx);

      if (!updated) {
        const product = await productsRepository.findStockInfo({ organizationId, id }, tx);
        if (!product) throw new NotFoundError('Product not found');
        if (!product.trackInventory) throw new ConflictError('Inventory is not tracked for this product', 'NOT_TRACKED');
        throw new ConflictError(`Only ${product.stockQuantity} in stock`, 'INSUFFICIENT_STOCK');
      }
      await productsRepository.insertStockMovement(
        { organizationId, productId: id, delta, balanceAfter: updated.stockQuantity, reason, createdBy: userId },
        tx,
      );
      return updated;
    });
  }

  async listMovements({ organizationId, id }: { organizationId: string; id: string }) {
    if (!(await productsRepository.findIdById({ organizationId, id }))) throw new NotFoundError('Product not found');
    return productsRepository.listMovements({ organizationId, productId: id });
  }

  // Categories
  listCategories({ organizationId }: { organizationId: string }) {
    return productsRepository.listCategories({ organizationId });
  }

  async createCategory({ organizationId, name }: { organizationId: string; name: string }) {
    const category = await productsRepository.insertCategory({ organizationId, name });
    if (!category) throw new ConflictError('A category with this name already exists', 'DUPLICATE_CATEGORY');
    return category;
  }

  async renameCategory({ organizationId, id, name }: { organizationId: string; id: string; name: string }) {
    const duplicate = await productsRepository.findCategoryIdByName({ organizationId, name });
    if (duplicate && duplicate.id !== id) throw new ConflictError('A category with this name already exists', 'DUPLICATE_CATEGORY');
    const category = await productsRepository.updateCategory({ organizationId, id, name });
    if (!category) throw new NotFoundError('Category not found');
    return category;
  }

  // Products in the category are kept and become uncategorised.
  async deleteCategory({ organizationId, id }: { organizationId: string; id: string }) {
    if (!(await productsRepository.deleteCategory({ organizationId, id }))) throw new NotFoundError('Category not found');
  }

  private async assertReferences({
    organizationId,
    input,
    selfId,
  }: {
    organizationId: string;
    input: { categoryId?: string | null; sku?: string | null };
    selfId?: string;
  }) {
    if (input.categoryId && !(await productsRepository.categoryExists({ organizationId, id: input.categoryId }))) {
      throw new BadRequestError('Category not found', 'INVALID_CATEGORY');
    }
    if (input.sku) {
      const duplicate = await productsRepository.findIdBySku({ organizationId, sku: input.sku });
      if (duplicate && duplicate.id !== selfId) throw new ConflictError('A product with this SKU already exists', 'DUPLICATE_SKU');
    }
  }

  // Same code path as the single-record endpoints, one item at a time.
  batch({ organizationId, userId, input }: { organizationId: string; userId: string; input: BatchProductsInput }) {
    return runBatch(input.ids, (id) =>
      input.action === 'delete' ? this.delete({ organizationId, id, userId }) : this.update({ organizationId, id, input: input.changes }),
    );
  }
}

export const productsService = new ProductsService();
