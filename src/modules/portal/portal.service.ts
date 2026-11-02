import { hashPassword, verifyPassword } from '@/shared/utils/password.js';
import { hashToken } from '@/modules/auth/auth.service.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { AuthCustomer } from './portal.auth.js';
import { portalRepository } from './portal.repository.js';
import {
  serializeAppointment,
  serializeDocument,
  serializeNotice,
  serializeInvoice,
  serializeOrder,
  serializeOrderHistory,
  serializeOrderItem,
  serializePayment,
  serializeProfile,
} from './portal.serializers.js';
import type { CreateAppointmentInput, UpdateProfileInput } from './portal.validation.js';

type Scope = Pick<AuthCustomer, 'organizationId' | 'contactId'>;

const MAX_OPEN_APPOINTMENTS = 5;

class PortalService {
  getProfile(customer: AuthCustomer) {
    return serializeProfile(customer);
  }

  async updateProfile(customer: AuthCustomer, input: UpdateProfileInput) {
    await portalRepository.updateContact(customer, input);
    return serializeProfile({ ...customer, ...input });
  }

  async changePassword({
    customer,
    token,
    currentPassword,
    newPassword,
  }: {
    customer: AuthCustomer;
    token: string;
    currentPassword: string;
    newPassword: string;
  }) {
    const hash = await portalRepository.findPasswordHash(customer.accountId);
    if (!hash || !(await verifyPassword(currentPassword, hash))) throw new UnauthorizedError('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    const passwordHash = await hashPassword(newPassword);
    await portalRepository.changePassword({ accountId: customer.accountId, passwordHash, keepTokenHash: hashToken(token) });
  }

  async listOrders(customer: Scope, query: ListQuery) {
    const { rows, total } = await portalRepository.listOrders(customer, query);
    return { rows: rows.map(serializeOrder), total };
  }

  async getOrder(customer: Scope, id: string) {
    const order = await portalRepository.findOrder(customer, id);
    if (!order) throw new NotFoundError('Order not found');
    const [items, history] = await Promise.all([
      portalRepository.listOrderItems(customer.organizationId, id),
      portalRepository.listOrderHistory(customer.organizationId, id),
    ]);
    return { ...serializeOrder(order), items: items.map(serializeOrderItem), history: history.map(serializeOrderHistory) };
  }

  async listInvoices(customer: Scope, query: ListQuery) {
    const { rows, total } = await portalRepository.listInvoices(customer, query);
    return { rows: rows.map(serializeInvoice), total };
  }

  async getInvoice(customer: Scope, id: string) {
    const invoice = await portalRepository.findInvoice(customer, id);
    if (!invoice) throw new NotFoundError('Invoice not found');

    const [items, paymentRows] = await Promise.all([
      portalRepository.listOrderItems(customer.organizationId, invoice.orderId),
      portalRepository.listInvoicePayments(customer.organizationId, id),
    ]);
    const refundRows = await Promise.all(paymentRows.map((p) => portalRepository.listRefundAmounts(customer.organizationId, p.id)));
    return {
      ...serializeInvoice(invoice),
      outstandingMinor: Math.max(0, invoice.totalMinor - invoice.paidMinor),
      items: items.map(serializeOrderItem),
      payments: paymentRows.map((p, i) =>
        serializePayment(
          p,
          (refundRows[i] ?? []).reduce((sum, r) => sum + r.amountMinor, 0),
        ),
      ),
    };
  }

  async listNotices(customer: Scope, query: ListQuery) {
    const { rows, total } = await portalRepository.listNotices(customer, query);
    return { rows: rows.map(serializeNotice), total };
  }

  async listDocuments(customer: Scope, query: ListQuery) {
    const { rows, total } = await portalRepository.listDocuments(customer, query);
    return { rows: rows.map(serializeDocument), total };
  }

  async getDocumentForDownload(customer: Scope, id: string) {
    const doc = await portalRepository.findDocumentForDownload(customer, id);
    if (!doc) throw new NotFoundError('Document not found');
    return doc;
  }

  async listAppointments(customer: Scope, query: ListQuery) {
    const { rows, total } = await portalRepository.listAppointments(customer, query);
    return { rows: rows.map(serializeAppointment), total };
  }

  async getAppointment(customer: Scope, id: string) {
    const row = await portalRepository.findAppointment(customer, id);
    if (!row) throw new NotFoundError('Appointment not found');
    return serializeAppointment(row);
  }

  async createAppointment(customer: Scope, input: CreateAppointmentInput) {
    const row = await portalRepository.createAppointment(customer, input, MAX_OPEN_APPOINTMENTS);
    if (!row) throw new ConflictError(`You can have at most ${MAX_OPEN_APPOINTMENTS} open appointment requests`, 'TOO_MANY_OPEN_APPOINTMENTS');
    return serializeAppointment(row);
  }

  async cancelAppointment(customer: Scope, id: string) {
    const row = await portalRepository.cancelAppointment(customer, id);
    if (!row) throw new NotFoundError('Appointment not found');
    if (row === 'invalid') throw new ConflictError('Only requested or confirmed appointments can be cancelled', 'INVALID_STATUS');
    return serializeAppointment(row);
  }
}

export const portalService = new PortalService();
