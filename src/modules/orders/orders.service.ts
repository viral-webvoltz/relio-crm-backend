import { withTransaction, type DbTransaction } from '@/config/database.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { ordersRepository } from './orders.repository.js';
import { calculateTotals } from './orders.totals.js';
import type { ChangeStatusInput, CreateOrderInput, OrderListQuery, OrderStatus } from './orders.validation.js';

// Fulfilled is final here; returning money is a separate refund flow.
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['fulfilled', 'cancelled'],
  fulfilled: [],
  cancelled: [],
};

const fullName = (c: { firstName: string; lastName: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(' ');

interface TakeStockParams {
  organizationId: string;
  userId: string;
  orderNumber: number;
  productId: string;
  quantity: number;
  unitPriceMinor?: number | undefined;
}

class OrdersService {
  list({ organizationId, query }: { organizationId: string; query: OrderListQuery }) {
    return ordersRepository.list({ organizationId, query });
  }

  async getById({ organizationId, id }: { organizationId: string; id: string }) {
    const order = await ordersRepository.findById({ organizationId, id });
    if (!order) throw new NotFoundError('Order not found');
    const [items, history] = await Promise.all([
      ordersRepository.findItems({ organizationId, orderId: id }),
      ordersRepository.findHistory({ organizationId, orderId: id }),
    ]);
    return { ...order, items, history: history.map((h) => ({ ...h.entry, changedByName: h.changedByName })) };
  }

  // The order-number upsert locks the organization's counter row until commit, so numbers are unique and gap-free
  // (and order creation within one organization is serialised, which also rules out stock deadlocks).
  // ponytail: per-organization serial order creation; fine for a CRM, shard the counter if orders/second ever matters.
  create(args: { organizationId: string; userId: string; input: CreateOrderInput }) {
    return withTransaction((tx) => this.createIn(tx, args));
  }

  // The body of create(), so a quote conversion can place the order inside its own transaction.
  // unitPrices (productId -> minor units) overrides the catalogue price, for lines whose price was agreed on a quote.
  async createIn(
    tx: DbTransaction,
    { organizationId, userId, input, unitPrices }: { organizationId: string; userId: string; input: CreateOrderInput; unitPrices?: Map<string, number> },
  ) {
    // Same product listed twice becomes one line.
    const quantities = new Map<string, number>();
    for (const { productId, quantity } of input.items) quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);

    const customerName = await this.resolveCustomerName(tx, organizationId, input);
    const orderNumber = await ordersRepository.nextOrderNumber({ organizationId }, tx);

    const lines = [];
    for (const [productId, quantity] of [...quantities].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(await this.takeStock(tx, { organizationId, userId, orderNumber, productId, quantity, unitPriceMinor: unitPrices?.get(productId) }));
    }

    const currencies = new Set(lines.map((l) => l.currency));
    const [currency] = currencies;
    if (!currency) throw new BadRequestError('An order needs at least one item', 'INVALID_PRODUCT');
    if (currencies.size > 1) throw new BadRequestError('All products in an order must use the same currency', 'MIXED_CURRENCY');

    let totals;
    try {
      totals = calculateTotals(lines, input.discount, input.taxRateBps);
    } catch {
      throw new BadRequestError('The discount is larger than the order subtotal', 'DISCOUNT_TOO_LARGE');
    }

    const order = await ordersRepository.insertOrder(
      {
        organizationId,
        orderNumber,
        contactId: input.contactId,
        companyId: input.companyId,
        customerName,
        currency,
        ...totals,
        discountType: input.discount?.type,
        discountValue: input.discount?.value,
        taxRateBps: input.taxRateBps,
        notes: input.notes,
        createdBy: userId,
      },
      tx,
    );
    await ordersRepository.insertItems(
      lines.map(({ currency: _currency, ...line }) => ({ ...line, organizationId, orderId: order.id, lineTotalMinor: line.unitPriceMinor * line.quantity })),
      tx,
    );
    await ordersRepository.insertStatusHistory({ organizationId, orderId: order.id, fromStatus: null, toStatus: 'pending', changedBy: userId }, tx);
    return order;
  }

  // The row lock serialises status changes, so two simultaneous cancellations cannot both restore stock.
  changeStatus({ organizationId, userId, id, input: { status, note } }: { organizationId: string; userId: string; id: string; input: ChangeStatusInput }) {
    return withTransaction(async (tx) => {
      const order = await ordersRepository.findByIdForUpdate({ organizationId, id }, tx);
      if (!order) throw new NotFoundError('Order not found');

      const from = order.status as OrderStatus;
      if (!TRANSITIONS[from].includes(status)) {
        throw new ConflictError(`A ${from} order cannot become ${status}`, 'INVALID_TRANSITION');
      }

      if (status === 'cancelled') {
        // Money must not be stranded on a cancelled order: refuse if anything is paid, otherwise void the unpaid invoice.
        const liveInvoices = await ordersRepository.findLiveInvoicesForUpdate({ organizationId, orderId: id }, tx);
        if (liveInvoices.some((invoice) => invoice.paidMinor > 0)) {
          throw new ConflictError('This order has payments. Refund them and void the invoice before cancelling.', 'ORDER_HAS_PAYMENTS');
        }
        if (liveInvoices.length > 0) {
          await ordersRepository.voidInvoices({ ids: liveInvoices.map((invoice) => invoice.id) }, tx);
        }

        const items = await ordersRepository.findStockedItems({ organizationId, orderId: id }, tx);
        for (const item of items) {
          const product = await ordersRepository.addStock({ organizationId, productId: item.productId, quantity: item.quantity }, tx);
          await ordersRepository.insertStockMovement(
            {
              organizationId,
              productId: item.productId,
              delta: item.quantity,
              balanceAfter: product!.stockQuantity,
              reason: `Order #${order.orderNumber} cancelled`,
              createdBy: userId,
            },
            tx,
          );
        }
      }

      const updated = await ordersRepository.updateStatus({ organizationId, id, status }, tx);
      await ordersRepository.insertStatusHistory({ organizationId, orderId: id, fromStatus: from, toStatus: status, note, changedBy: userId }, tx);
      return updated;
    });
  }

  private async resolveCustomerName(tx: DbTransaction, organizationId: string, input: CreateOrderInput) {
    let customerName: string | null = null;
    if (input.contactId) {
      const contact = await ordersRepository.findContactName({ organizationId, id: input.contactId }, tx);
      if (!contact) throw new BadRequestError('Contact not found', 'INVALID_CONTACT');
      customerName = fullName(contact);
    }
    if (input.companyId) {
      const company = await ordersRepository.findCompanyName({ organizationId, id: input.companyId }, tx);
      if (!company) throw new BadRequestError('Company not found', 'INVALID_COMPANY');
      customerName ??= company.name;
    }
    return customerName;
  }

  // One atomic conditional UPDATE per product: it succeeds only if enough stock is left, so concurrent orders
  // cannot oversell. Any failure rolls the whole transaction back, stock included.
  private async takeStock(tx: DbTransaction, { organizationId, userId, orderNumber, productId, quantity, unitPriceMinor }: TakeStockParams) {
    const product = await ordersRepository.takeStockIfAvailable({ organizationId, productId, quantity }, tx);

    if (!product) {
      const existing = await ordersRepository.findProductStockInfo({ organizationId, productId }, tx);
      if (!existing) throw new BadRequestError('A product in this order does not exist', 'INVALID_PRODUCT');
      if (!existing.isActive) throw new ConflictError(`"${existing.name}" is not available`, 'PRODUCT_INACTIVE');
      throw new ConflictError(`Only ${existing.stockQuantity} of "${existing.name}" in stock`, 'INSUFFICIENT_STOCK');
    }
    if (product.trackInventory) {
      await ordersRepository.insertStockMovement(
        { organizationId, productId, delta: -quantity, balanceAfter: product.stockQuantity, reason: `Order #${orderNumber}`, createdBy: userId },
        tx,
      );
    }
    return {
      productId,
      productName: product.name,
      sku: product.sku,
      unitPriceMinor: unitPriceMinor ?? product.priceMinor,
      quantity,
      stockDeducted: product.trackInventory,
      currency: product.currency,
    };
  }
}

export const ordersService = new OrdersService();
