import { withTransaction, type DbTransaction } from '@/config/database.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { invoicesRepository } from './invoices.repository.js';
import { statusForPayment } from './invoices.status.js';
import type { CreateInvoiceInput, InvoiceListQuery, RecordPaymentInput, RefundInput } from './invoices.validation.js';

const DEFAULT_TERMS_DAYS = 14;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BACKDATE_MS = 90 * 86_400_000;

const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type InvoiceRow = NonNullable<Awaited<ReturnType<typeof invoicesRepository.lockById>>>;

class InvoicesService {
  create(args: { organizationId: string; userId: string; input: CreateInvoiceInput }) {
    return withTransaction((tx) => this.createIn(tx, args));
  }

  // The body of create(), so a quote conversion can invoice inside its own transaction.
  async createIn(tx: DbTransaction, { organizationId, userId, input }: { organizationId: string; userId: string; input: CreateInvoiceInput }) {
    const order = await invoicesRepository.findOrderForInvoice({ organizationId, orderId: input.orderId }, tx);
    if (!order) throw new BadRequestError('Order not found', 'INVALID_ORDER');
    if (order.status === 'cancelled') throw new ConflictError('A cancelled order cannot be invoiced', 'ORDER_CANCELLED');

    const live = await invoicesRepository.findLiveInvoiceIdByOrder({ organizationId, orderId: order.id }, tx);
    if (live) throw new ConflictError('This order already has an invoice', 'INVOICE_EXISTS');

    const invoiceNumber = await invoicesRepository.nextInvoiceNumber({ organizationId }, tx);
    return invoicesRepository.create(
      {
        values: {
          organizationId,
          invoiceNumber,
          orderId: order.id,
          customerName: order.customerName,
          currency: order.currency,
          totalMinor: order.totalMinor,
          status: statusForPayment(order.totalMinor, 0),
          dueDate: input.dueDate ?? addDays(DEFAULT_TERMS_DAYS),
          notes: input.notes,
          createdBy: userId,
        },
      },
      tx,
    );
  }

  async list({ organizationId, query }: { organizationId: string; query: InvoiceListQuery }) {
    const [rows, total] = await Promise.all([invoicesRepository.list({ organizationId, query }), invoicesRepository.count({ organizationId, query })]);
    return { rows, total };
  }

  async getById({ organizationId, id }: { organizationId: string; id: string }) {
    const row = await invoicesRepository.findWithOrderNumber({ organizationId, id });
    if (!row) throw new NotFoundError('Invoice not found');

    const [items, paymentRows] = await Promise.all([
      invoicesRepository.listOrderItems({ orderId: row.invoice.orderId }),
      invoicesRepository.listPayments({ invoiceId: id }),
    ]);
    const refundRows = paymentRows.length ? await invoicesRepository.listRefundsForPayments({ paymentIds: paymentRows.map((p) => p.payment.id) }) : [];

    return {
      ...row.invoice,
      orderNumber: row.orderNumber,
      outstandingMinor: row.invoice.status === 'void' ? 0 : Math.max(0, row.invoice.totalMinor - row.invoice.paidMinor),
      items,
      payments: paymentRows.map(({ payment, recordedBy }) => {
        const own = refundRows.filter((r) => r.paymentId === payment.id);
        const refundedMinor = own.reduce((sum, r) => sum + r.amountMinor, 0);
        return { ...payment, recordedBy, refunds: own, refundedMinor, refundableMinor: payment.amountMinor - refundedMinor };
      }),
    };
  }

  async recordPayment({ organizationId, userId, invoiceId, input }: { organizationId: string; userId: string; invoiceId: string; input: RecordPaymentInput }) {
    return withTransaction(async (tx) => {
      if (input.paidAt) {
        const paidAt = new Date(input.paidAt).getTime();
        if (paidAt > Date.now() + MAX_CLOCK_SKEW_MS) throw new BadRequestError('Payment date cannot be in the future', 'INVALID_PAID_AT');
        if (paidAt < Date.now() - MAX_BACKDATE_MS) throw new BadRequestError('Payment date is too far in the past', 'INVALID_PAID_AT');
      }
      const invoice = await this.lockInvoice(tx, organizationId, invoiceId);

      // Same key again = the same submission retried: hand back the original instead of paying twice.
      if (input.idempotencyKey) {
        const existing = await invoicesRepository.findPaymentByIdempotencyKey({ organizationId, idempotencyKey: input.idempotencyKey }, tx);
        if (existing) {
          if (existing.invoiceId !== invoiceId) throw new ConflictError('This request key was already used for another invoice', 'IDEMPOTENCY_KEY_REUSED');
          return { payment: existing, invoice, isDuplicate: true };
        }
      }

      if (invoice.status === 'void') throw new ConflictError('A void invoice cannot take payments', 'INVOICE_VOID');
      const outstanding = invoice.totalMinor - invoice.paidMinor;
      if (input.amountMinor > outstanding) throw new ConflictError(`Only ${outstanding} is outstanding on this invoice`, 'EXCEEDS_BALANCE');

      const payment = await invoicesRepository.createPayment(
        {
          values: {
            organizationId,
            invoiceId,
            amountMinor: input.amountMinor,
            method: input.method,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            createdBy: userId,
            ...(input.paidAt && { paidAt: new Date(input.paidAt) }),
          },
        },
        tx,
      );
      await audit(
        {
          organizationId,
          actorUserId: userId,
          action: 'payment.recorded',
          targetType: 'invoice',
          targetId: invoiceId,
          metadata: { paymentId: payment.id, amountMinor: input.amountMinor, method: input.method, paidAt: input.paidAt },
        },
        tx,
      );
      return { payment, invoice: await this.recalculate(tx, invoice), isDuplicate: false };
    });
  }

  async refundPayment({ organizationId, userId, paymentId, input }: { organizationId: string; userId: string; paymentId: string; input: RefundInput }) {
    return withTransaction(async (tx) => {
      const found = await invoicesRepository.findPaymentById({ organizationId, id: paymentId }, tx);
      if (!found) throw new NotFoundError('Payment not found');

      // Lock the invoice first (same order as recordPayment), then read what was already refunded.
      const invoice = await this.lockInvoice(tx, organizationId, found.invoiceId);
      const refunded = await invoicesRepository.sumRefundsForPayment({ paymentId }, tx);
      const refundable = found.amountMinor - refunded;
      if (input.amountMinor > refundable) throw new ConflictError(`Only ${refundable} of this payment can still be refunded`, 'EXCEEDS_PAYMENT');

      const refund = await invoicesRepository.createRefund(
        { values: { organizationId, paymentId, amountMinor: input.amountMinor, reason: input.reason, createdBy: userId } },
        tx,
      );
      await audit(
        {
          organizationId,
          actorUserId: userId,
          action: 'payment.refunded',
          targetType: 'payment',
          targetId: paymentId,
          metadata: { refundId: refund.id, amountMinor: input.amountMinor },
        },
        tx,
      );
      return { refund, invoice: invoice.status === 'void' ? invoice : await this.recalculate(tx, invoice) };
    });
  }

  // Only an invoice with no net money on it can be voided; refund first if something was paid.
  async void({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }) {
    return withTransaction(async (tx) => {
      const invoice = await this.lockInvoice(tx, organizationId, id);
      if (invoice.status === 'void') throw new ConflictError('The invoice is already void', 'ALREADY_VOID');
      if (invoice.paidMinor > 0) throw new ConflictError('Refund the payments before voiding this invoice', 'HAS_PAYMENTS');
      await audit({ organizationId, actorUserId: userId, action: 'invoice.voided', targetType: 'invoice', targetId: id }, tx);
      return invoicesRepository.markVoid({ id }, tx);
    });
  }

  // The invoice row lock serialises payments, refunds and voids on that invoice, so none can overpay or double-count.
  private async lockInvoice(tx: DbTransaction, organizationId: string, id: string) {
    const invoice = await invoicesRepository.lockById({ organizationId, id }, tx);
    if (!invoice) throw new NotFoundError('Invoice not found');
    return invoice;
  }

  // Paid amount is always recomputed from the payment and refund rows, never nudged incrementally.
  private async recalculate(tx: DbTransaction, invoice: InvoiceRow) {
    const paid = await invoicesRepository.sumPayments({ invoiceId: invoice.id }, tx);
    const refunded = await invoicesRepository.sumRefundsForInvoice({ invoiceId: invoice.id }, tx);
    const paidMinor = paid - refunded;
    return invoicesRepository.updatePaid({ id: invoice.id, paidMinor, status: statusForPayment(invoice.totalMinor, paidMinor) }, tx);
  }
}

export const invoicesService = new InvoicesService();
