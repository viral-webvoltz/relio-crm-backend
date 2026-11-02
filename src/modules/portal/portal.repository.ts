import { and, asc, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import {
  contacts,
  customerAccounts,
  customerSessions,
  invoices,
  orderItems,
  orders,
  orderStatusHistory,
  organizations,
  payments,
  refunds,
} from '@/database/schema/index.js';
import { portalAppointments, portalDocuments } from '@/database/schema/portal-extras.js';
import { portalNoticesRepository } from '@/modules/portal-notices/portal-notices.repository.js';
import type { ListQuery } from '@/shared/pagination/index.js';

// Everything here is scoped by the customer's own contact id, which comes from the server-side session.
// Responses name their columns explicitly, so internal fields (order/invoice notes, staff names, who created
// what, payment references) can never leak by accident when a table gains a new column.
interface Scope {
  organizationId: string;
  contactId: string;
}

const ownOrder = ({ organizationId, contactId }: Scope, id?: string) =>
  and(eq(orders.organizationId, organizationId), eq(orders.contactId, contactId), id ? eq(orders.id, id) : undefined);

// Voided invoices are an internal correction, so customers never see them.
const ownInvoice = ({ organizationId, contactId }: Scope, id?: string) =>
  and(
    eq(invoices.organizationId, organizationId),
    eq(orders.organizationId, organizationId),
    eq(orders.contactId, contactId),
    ne(invoices.status, 'void'),
    id ? eq(invoices.id, id) : undefined,
  );

const orderColumns = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  status: orders.status,
  currency: orders.currency,
  subtotalMinor: orders.subtotalMinor,
  discountMinor: orders.discountMinor,
  taxMinor: orders.taxMinor,
  totalMinor: orders.totalMinor,
  createdAt: orders.createdAt,
};

const invoiceColumns = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  status: invoices.status,
  currency: invoices.currency,
  totalMinor: invoices.totalMinor,
  paidMinor: invoices.paidMinor,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  orderId: invoices.orderId,
  orderNumber: orders.orderNumber,
};

const itemColumns = {
  id: orderItems.id,
  productName: orderItems.productName,
  unitPriceMinor: orderItems.unitPriceMinor,
  quantity: orderItems.quantity,
  lineTotalMinor: orderItems.lineTotalMinor,
};

const ownDocument = ({ organizationId, contactId }: Scope, id?: string) =>
  and(eq(portalDocuments.organizationId, organizationId), eq(portalDocuments.contactId, contactId), id ? eq(portalDocuments.id, id) : undefined);

const ownAppointment = ({ organizationId, contactId }: Scope, id?: string) =>
  and(eq(portalAppointments.organizationId, organizationId), eq(portalAppointments.contactId, contactId), id ? eq(portalAppointments.id, id) : undefined);

const documentColumns = {
  id: portalDocuments.id,
  name: portalDocuments.name,
  fileName: portalDocuments.fileName,
  mimeType: portalDocuments.mimeType,
  sizeBytes: portalDocuments.sizeBytes,
  createdAt: portalDocuments.createdAt,
};

// assignedTo and staffNotes are deliberately not selected.
const appointmentColumns = {
  id: portalAppointments.id,
  subject: portalAppointments.subject,
  notes: portalAppointments.notes,
  startsAt: portalAppointments.startsAt,
  durationMinutes: portalAppointments.durationMinutes,
  status: portalAppointments.status,
  createdAt: portalAppointments.createdAt,
  updatedAt: portalAppointments.updatedAt,
};

class PortalRepository {
  // ---- Customer sessions ----

  async findLoginAccount(organizationSlug: string, email: string) {
    const [row] = await db
      .select({ account: customerAccounts })
      .from(customerAccounts)
      .innerJoin(organizations, eq(organizations.id, customerAccounts.organizationId))
      .where(and(eq(organizations.slug, organizationSlug), eq(customerAccounts.email, email)));
    return row;
  }

  async insertSession(values: { customerAccountId: string; tokenHash: string; expiresAt: Date }) {
    await db.insert(customerSessions).values(values);
  }

  async touchLastLogin(accountId: string) {
    await db.update(customerAccounts).set({ lastLoginAt: new Date() }).where(eq(customerAccounts.id, accountId));
  }

  async deleteSessionByTokenHash(tokenHash: string) {
    await db.delete(customerSessions).where(eq(customerSessions.tokenHash, tokenHash));
  }

  async findCustomerBySessionTokenHash(tokenHash: string) {
    const [row] = await db
      .select({
        accountId: customerAccounts.id,
        organizationId: customerAccounts.organizationId,
        contactId: customerAccounts.contactId,
        email: customerAccounts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        phone: contacts.phone,
        organizationName: organizations.name,
        mustChangePassword: customerAccounts.mustChangePassword,
      })
      .from(customerSessions)
      .innerJoin(customerAccounts, eq(customerAccounts.id, customerSessions.customerAccountId))
      .innerJoin(contacts, eq(contacts.id, customerAccounts.contactId))
      .innerJoin(organizations, eq(organizations.id, customerAccounts.organizationId))
      .where(
        and(
          eq(customerSessions.tokenHash, tokenHash),
          gt(customerSessions.expiresAt, new Date()),
          eq(customerAccounts.isActive, true),
          isNull(contacts.deletedAt),
        ),
      );
    return row;
  }

  // ---- Orders ----

  async listOrders(customer: Scope, { page, limit }: ListQuery) {
    const [rows, [total]] = await Promise.all([
      db
        .select(orderColumns)
        .from(orders)
        .where(ownOrder(customer))
        .orderBy(desc(orders.orderNumber))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(orders).where(ownOrder(customer)),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findOrder(customer: Scope, id: string) {
    const [order] = await db.select(orderColumns).from(orders).where(ownOrder(customer, id));
    return order;
  }

  listOrderItems(organizationId: string, orderId: string) {
    return db
      .select(itemColumns)
      .from(orderItems)
      .where(and(eq(orderItems.organizationId, organizationId), eq(orderItems.orderId, orderId)))
      .orderBy(asc(orderItems.productName));
  }

  // Status and time only: staff notes and names stay internal.
  listOrderHistory(organizationId: string, orderId: string) {
    return db
      .select({ id: orderStatusHistory.id, toStatus: orderStatusHistory.toStatus, createdAt: orderStatusHistory.createdAt })
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.organizationId, organizationId), eq(orderStatusHistory.orderId, orderId)))
      .orderBy(asc(orderStatusHistory.createdAt));
  }

  // ---- Invoices ----

  async listInvoices(customer: Scope, { page, limit }: ListQuery) {
    const [rows, [total]] = await Promise.all([
      db
        .select(invoiceColumns)
        .from(invoices)
        .innerJoin(orders, eq(orders.id, invoices.orderId))
        .where(ownInvoice(customer))
        .orderBy(desc(invoices.invoiceNumber))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(invoices).innerJoin(orders, eq(orders.id, invoices.orderId)).where(ownInvoice(customer)),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findInvoice(customer: Scope, id: string) {
    const [invoice] = await db.select(invoiceColumns).from(invoices).innerJoin(orders, eq(orders.id, invoices.orderId)).where(ownInvoice(customer, id));
    return invoice;
  }

  listInvoicePayments(organizationId: string, invoiceId: string) {
    return db
      .select({ id: payments.id, amountMinor: payments.amountMinor, method: payments.method, paidAt: payments.paidAt })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.invoiceId, invoiceId)))
      .orderBy(asc(payments.paidAt));
  }

  // Refunds appear only as an amount returned on that payment; the staff reason stays internal.
  listRefundAmounts(organizationId: string, paymentId: string) {
    return db
      .select({ amountMinor: refunds.amountMinor })
      .from(refunds)
      .where(and(eq(refunds.organizationId, organizationId), eq(refunds.paymentId, paymentId)));
  }

  // ---- Profile ----

  async updateContact({ organizationId, contactId }: Scope, values: { firstName?: string; lastName?: string | null; phone?: string | null }) {
    await db
      .update(contacts)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)));
  }

  async updatePasswordHash(accountId: string, passwordHash: string) {
    await db.update(customerAccounts).set({ passwordHash }).where(eq(customerAccounts.id, accountId));
  }

  async findPasswordHash(accountId: string) {
    const [row] = await db.select({ passwordHash: customerAccounts.passwordHash }).from(customerAccounts).where(eq(customerAccounts.id, accountId));
    return row?.passwordHash;
  }

  // The new hash and the session cleanup commit together, so a half-applied change cannot leave old sessions alive.
  async changePassword({ accountId, passwordHash, keepTokenHash }: { accountId: string; passwordHash: string; keepTokenHash: string }) {
    await db.transaction(async (tx) => {
      await tx.update(customerAccounts).set({ passwordHash, mustChangePassword: false, updatedAt: new Date() }).where(eq(customerAccounts.id, accountId));
      await tx.delete(customerSessions).where(and(eq(customerSessions.customerAccountId, accountId), ne(customerSessions.tokenHash, keepTokenHash)));
    });
  }

  // ---- Notices ----

  listNotices(customer: Scope, query: ListQuery) {
    return portalNoticesRepository.listVisible(customer.organizationId, query);
  }

  // ---- Documents ----

  // The content column is never part of a listing.
  async listDocuments(customer: Scope, { page, limit }: ListQuery) {
    const where = ownDocument(customer);
    const [rows, [total]] = await Promise.all([
      db
        .select(documentColumns)
        .from(portalDocuments)
        .where(where)
        .orderBy(desc(portalDocuments.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(portalDocuments).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findDocumentForDownload(customer: Scope, id: string) {
    const [row] = await db
      .select({ fileName: portalDocuments.fileName, mimeType: portalDocuments.mimeType, content: portalDocuments.content })
      .from(portalDocuments)
      .where(ownDocument(customer, id));
    return row;
  }

  // ---- Appointments ----

  async listAppointments(customer: Scope, { page, limit }: ListQuery) {
    const where = ownAppointment(customer);
    const [rows, [total]] = await Promise.all([
      db
        .select(appointmentColumns)
        .from(portalAppointments)
        .where(where)
        .orderBy(desc(portalAppointments.startsAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(portalAppointments).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findAppointment(customer: Scope, id: string) {
    const [row] = await db.select(appointmentColumns).from(portalAppointments).where(ownAppointment(customer, id));
    return row;
  }

  // The per-customer advisory lock makes the open-request count and the insert atomic, so parallel requests cannot exceed the cap.
  async createAppointment(customer: Scope, values: { subject: string; notes?: string; startsAt: Date; durationMinutes: number }, maxOpen: number) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${customer.contactId}))`);
      const [open] = await tx
        .select({ value: count() })
        .from(portalAppointments)
        .where(and(ownAppointment(customer), inArray(portalAppointments.status, ['requested', 'confirmed'])));
      if ((open?.value ?? 0) >= maxOpen) return undefined;
      const [row] = await tx
        .insert(portalAppointments)
        .values({ ...values, organizationId: customer.organizationId, contactId: customer.contactId })
        .returning(appointmentColumns);
      return row;
    });
  }

  // Locks the row, so a staff status change and a cancel cannot both win. Returns 'invalid' when it can no longer be cancelled.
  async cancelAppointment(customer: Scope, id: string) {
    return db.transaction(async (tx) => {
      const [current] = await tx.select({ status: portalAppointments.status }).from(portalAppointments).where(ownAppointment(customer, id)).for('update');
      if (!current) return undefined;
      if (current.status !== 'requested' && current.status !== 'confirmed') return 'invalid' as const;
      const [row] = await tx
        .update(portalAppointments)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(ownAppointment(customer, id))
        .returning(appointmentColumns);
      return row;
    });
  }
}

export const portalRepository = new PortalRepository();
