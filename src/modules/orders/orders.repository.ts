import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, sql } from 'drizzle-orm';
import { likeContains } from '@/shared/utils/like.js';
import { db, type DbExecutor } from '@/config/database.js';
import {
  companies,
  contacts,
  invoices,
  orderItems,
  orders,
  orderSequences,
  orderStatusHistory,
  products,
  stockMovements,
  users,
} from '@/database/schema/index.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import type { OrderListQuery } from './orders.validation.js';

type NewOrder = typeof orders.$inferInsert;
type NewOrderItem = typeof orderItems.$inferInsert;
type NewStatusHistory = typeof orderStatusHistory.$inferInsert;
type NewStockMovement = typeof stockMovements.$inferInsert;

const orderScope = (organizationId: string, id: string) => and(eq(orders.organizationId, organizationId), eq(orders.id, id));

class OrdersRepository {
  async list({ organizationId, query: { page, limit, search, status, sort, dir } }: { organizationId: string; query: OrderListQuery }) {
    const term = search ? likeContains(search) : '';
    const isNumber = search && /^#?\d+$/.test(search);
    const where = and(
      eq(orders.organizationId, organizationId),
      status ? eq(orders.status, status) : undefined,
      search ? (isNumber ? eq(orders.orderNumber, Number(search.replace('#', ''))) : ilike(orders.customerName, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(orders)
        .where(where)
        .orderBy(
          ...orderByClause(
            { orderNumber: orders.orderNumber, customer: orders.customerName, status: orders.status, total: orders.totalMinor, createdAt: orders.createdAt },
            { sort, dir },
            [desc(orders.orderNumber)],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(orders).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }) {
    const [order] = await db.select().from(orders).where(orderScope(organizationId, id));
    return order;
  }

  findItems({ organizationId, orderId }: { organizationId: string; orderId: string }) {
    return db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.organizationId, organizationId), eq(orderItems.orderId, orderId)))
      .orderBy(asc(orderItems.productName));
  }

  findHistory({ organizationId, orderId }: { organizationId: string; orderId: string }) {
    return db
      .select({ entry: orderStatusHistory, changedByName: users.fullName })
      .from(orderStatusHistory)
      .leftJoin(users, eq(users.id, orderStatusHistory.changedBy))
      .where(and(eq(orderStatusHistory.organizationId, organizationId), eq(orderStatusHistory.orderId, orderId)))
      .orderBy(asc(orderStatusHistory.createdAt));
  }

  async findContactName({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [contact] = await executor
      .select({ firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNull(contacts.deletedAt)));
    return contact;
  }

  async findCompanyName({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [company] = await executor
      .select({ name: companies.name })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.id, id), isNull(companies.deletedAt)));
    return company;
  }

  // The upsert locks the organization's counter row until commit.
  async nextOrderNumber({ organizationId }: { organizationId: string }, executor: DbExecutor = db) {
    const [sequence] = await executor
      .insert(orderSequences)
      .values({ organizationId, lastNumber: 1001 })
      .onConflictDoUpdate({ target: orderSequences.organizationId, set: { lastNumber: sql`${orderSequences.lastNumber} + 1` } })
      .returning();
    return sequence!.lastNumber;
  }

  // Atomic conditional UPDATE: succeeds only if the product is active and enough stock is left.
  async takeStockIfAvailable(
    { organizationId, productId, quantity }: { organizationId: string; productId: string; quantity: number },
    executor: DbExecutor = db,
  ) {
    const [product] = await executor
      .update(products)
      .set({
        stockQuantity: sql`case when ${products.trackInventory} then ${products.stockQuantity} - ${quantity} else ${products.stockQuantity} end`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(products.organizationId, organizationId),
          eq(products.id, productId),
          eq(products.isActive, true),
          isNull(products.deletedAt),
          sql`(not ${products.trackInventory} or ${products.stockQuantity} >= ${quantity})`,
        ),
      )
      .returning();
    return product;
  }

  async findProductStockInfo({ organizationId, productId }: { organizationId: string; productId: string }, executor: DbExecutor = db) {
    const [product] = await executor
      .select({ name: products.name, isActive: products.isActive, stockQuantity: products.stockQuantity })
      .from(products)
      .where(and(eq(products.organizationId, organizationId), eq(products.id, productId), isNull(products.deletedAt)));
    return product;
  }

  async addStock({ organizationId, productId, quantity }: { organizationId: string; productId: string; quantity: number }, executor: DbExecutor = db) {
    const [product] = await executor
      .update(products)
      .set({ stockQuantity: sql`${products.stockQuantity} + ${quantity}`, updatedAt: new Date() })
      .where(and(eq(products.organizationId, organizationId), eq(products.id, productId)))
      .returning();
    return product;
  }

  async insertStockMovement(values: NewStockMovement, executor: DbExecutor = db) {
    await executor.insert(stockMovements).values(values);
  }

  async insertOrder(values: NewOrder, executor: DbExecutor = db) {
    const [order] = await executor.insert(orders).values(values).returning();
    return order!;
  }

  async insertItems(values: NewOrderItem[], executor: DbExecutor = db) {
    await executor.insert(orderItems).values(values);
  }

  async insertStatusHistory(values: NewStatusHistory, executor: DbExecutor = db) {
    await executor.insert(orderStatusHistory).values(values);
  }

  async findByIdForUpdate({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [order] = await executor.select().from(orders).where(orderScope(organizationId, id)).for('update');
    return order;
  }

  findLiveInvoicesForUpdate({ organizationId, orderId }: { organizationId: string; orderId: string }, executor: DbExecutor = db) {
    return executor
      .select({ id: invoices.id, paidMinor: invoices.paidMinor })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.orderId, orderId), ne(invoices.status, 'void')))
      .for('update');
  }

  async voidInvoices({ ids }: { ids: string[] }, executor: DbExecutor = db) {
    await executor.update(invoices).set({ status: 'void', updatedAt: new Date() }).where(inArray(invoices.id, ids));
  }

  findStockedItems({ organizationId, orderId }: { organizationId: string; orderId: string }, executor: DbExecutor = db) {
    return executor
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.organizationId, organizationId), eq(orderItems.orderId, orderId), eq(orderItems.stockDeducted, true)))
      .orderBy(asc(orderItems.productId));
  }

  async updateStatus({ organizationId, id, status }: { organizationId: string; id: string; status: NewOrder['status'] }, executor: DbExecutor = db) {
    const [updated] = await executor.update(orders).set({ status, updatedAt: new Date() }).where(orderScope(organizationId, id)).returning();
    return updated!;
  }
}

export const ordersRepository = new OrdersRepository();
