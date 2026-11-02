import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db, type DbExecutor } from '@/config/database.js';
import { productCategories, products, stockMovements, users } from '@/database/schema/index.js';
import { restoreSet, softDeleteSet } from '@/database/soft-delete.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { ProductListQuery } from './products.validation.js';

type NewProduct = typeof products.$inferInsert;
type ProductChanges = Partial<Omit<NewProduct, 'id' | 'organizationId'>>;
type NewStockMovement = typeof stockMovements.$inferInsert;

const scope = (organizationId: string, id: string) => and(eq(products.organizationId, organizationId), eq(products.id, id), isNull(products.deletedAt));
const categoryScope = (organizationId: string, id: string) => and(eq(productCategories.organizationId, organizationId), eq(productCategories.id, id));

class ProductsRepository {
  async list({ organizationId, query: { page, limit, search, categoryId, status, sort, dir } }: { organizationId: string; query: ProductListQuery }) {
    const term = search ? likeContains(search) : '';
    const where = and(
      eq(products.organizationId, organizationId),
      isNull(products.deletedAt),
      categoryId ? eq(products.categoryId, categoryId) : undefined,
      status ? eq(products.isActive, status === 'active') : undefined,
      search ? or(ilike(products.name, term), ilike(products.sku, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({ product: products, categoryName: productCategories.name })
        .from(products)
        .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
        .where(where)
        .orderBy(
          ...orderByClause(
            {
              name: products.name,
              sku: products.sku,
              category: productCategories.name,
              price: products.priceMinor,
              stock: products.stockQuantity,
              createdAt: products.createdAt,
            },
            { sort, dir },
            [asc(products.name)],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(products).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.product, categoryName: r.categoryName })), total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [product] = await executor.select().from(products).where(scope(organizationId, id));
    return product;
  }

  async findIdById({ organizationId, id }: { organizationId: string; id: string }) {
    const [row] = await db.select({ id: products.id }).from(products).where(scope(organizationId, id));
    return row;
  }

  async findIdBySku({ organizationId, sku }: { organizationId: string; sku: string }) {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.organizationId, organizationId), eq(products.sku, sku), isNull(products.deletedAt)));
    return row;
  }

  async insert(values: NewProduct, executor: DbExecutor = db) {
    const [product] = await executor.insert(products).values(values).returning();
    return product!;
  }

  async update({ organizationId, id, changes }: { organizationId: string; id: string; changes: ProductChanges }) {
    const [product] = await db
      .update(products)
      .set({ ...changes, updatedAt: new Date() })
      .where(scope(organizationId, id))
      .returning();
    return product;
  }

  async delete({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }) {
    const deleted = await db.update(products).set(softDeleteSet(userId)).where(scope(organizationId, id)).returning({ id: products.id });
    return deleted.length > 0;
  }

  async listDeleted({ organizationId, query: { page, limit, search } }: { organizationId: string; query: ListQuery }) {
    const term = search ? likeContains(search) : '';
    const where = and(
      eq(products.organizationId, organizationId),
      isNotNull(products.deletedAt),
      search ? or(ilike(products.name, term), ilike(products.sku, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({ product: products, categoryName: productCategories.name })
        .from(products)
        .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
        .where(where)
        .orderBy(desc(products.deletedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(products).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.product, categoryName: r.categoryName })), total: total?.value ?? 0 };
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }) {
    const [product] = await db
      .update(products)
      .set(restoreSet)
      .where(and(eq(products.organizationId, organizationId), eq(products.id, id), isNotNull(products.deletedAt)))
      .returning();
    return product;
  }

  // Atomic conditional UPDATE: concurrent adjustments cannot push stock below zero or lose a change.
  async adjustStockIfAllowed({ organizationId, id, delta }: { organizationId: string; id: string; delta: number }, executor: DbExecutor = db) {
    const [updated] = await executor
      .update(products)
      .set({ stockQuantity: sql`${products.stockQuantity} + ${delta}`, updatedAt: new Date() })
      .where(and(scope(organizationId, id), eq(products.trackInventory, true), sql`${products.stockQuantity} + ${delta} between 0 and 2000000000`))
      .returning();
    return updated;
  }

  async findStockInfo({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [product] = await executor
      .select({ trackInventory: products.trackInventory, stockQuantity: products.stockQuantity })
      .from(products)
      .where(scope(organizationId, id));
    return product;
  }

  async insertStockMovement(values: NewStockMovement, executor: DbExecutor = db) {
    await executor.insert(stockMovements).values(values);
  }

  async listMovements({ organizationId, productId }: { organizationId: string; productId: string }) {
    const rows = await db
      .select({ movement: stockMovements, createdByName: users.fullName })
      .from(stockMovements)
      .leftJoin(users, eq(users.id, stockMovements.createdBy))
      .where(and(eq(stockMovements.organizationId, organizationId), eq(stockMovements.productId, productId)))
      .orderBy(desc(stockMovements.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...r.movement, createdByName: r.createdByName }));
  }

  // Categories
  listCategories({ organizationId }: { organizationId: string }) {
    return db.select().from(productCategories).where(eq(productCategories.organizationId, organizationId)).orderBy(productCategories.name);
  }

  async categoryExists({ organizationId, id }: { organizationId: string; id: string }) {
    const [row] = await db.select({ id: productCategories.id }).from(productCategories).where(categoryScope(organizationId, id));
    return Boolean(row);
  }

  async findCategoryIdByName({ organizationId, name }: { organizationId: string; name: string }) {
    const [row] = await db
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(and(eq(productCategories.organizationId, organizationId), eq(productCategories.name, name)));
    return row;
  }

  async insertCategory({ organizationId, name }: { organizationId: string; name: string }) {
    const [category] = await db.insert(productCategories).values({ organizationId, name }).onConflictDoNothing().returning();
    return category;
  }

  async updateCategory({ organizationId, id, name }: { organizationId: string; id: string; name: string }) {
    const [category] = await db.update(productCategories).set({ name }).where(categoryScope(organizationId, id)).returning();
    return category;
  }

  async deleteCategory({ organizationId, id }: { organizationId: string; id: string }) {
    const deleted = await db.delete(productCategories).where(categoryScope(organizationId, id)).returning({ id: productCategories.id });
    return deleted.length > 0;
  }
}

export const productsRepository = new ProductsRepository();
