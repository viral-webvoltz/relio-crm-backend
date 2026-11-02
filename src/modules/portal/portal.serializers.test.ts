import { describe, expect, it } from 'vitest';
import * as s from './portal.serializers.js';

const sorted = (o: object) => Object.keys(o).sort();
const now = new Date();
// Fields that must never reach a customer, mixed into every input row.
const secrets = {
  createdBy: 'u',
  organizationId: 'o',
  contactId: 'c',
  assignedTo: 'a',
  staffNotes: 's',
  content: 'bytes',
  isInternal: true,
  costMinor: 1,
  reference: 'r',
  reason: 'why',
  passwordHash: 'h',
  priority: 'urgent',
  slaDueAt: now,
};

function expectExact(out: object, allowed: readonly string[]) {
  expect(sorted(out)).toEqual([...allowed].sort());
  for (const key of Object.keys(secrets)) expect(out).not.toHaveProperty(key);
}

describe('portal serializers match their public field lists', () => {
  it('profile', () => {
    const row = { ...secrets, firstName: 'A', lastName: 'B', phone: '1', email: 'e', organizationName: 'Org', mustChangePassword: true };
    const out = s.serializeProfile(row);
    expectExact(out, s.portalProfileFields);
    expect(out.name).toBe('A B');
  });

  it('order', () => {
    const row = {
      ...secrets,
      notes: 'internal',
      id: '1',
      orderNumber: 1,
      status: 'p',
      currency: 'USD',
      subtotalMinor: 1,
      discountMinor: 1,
      taxMinor: 1,
      totalMinor: 1,
      createdAt: now,
    };
    const out = s.serializeOrder(row);
    expectExact(out, s.portalOrderFields);
    expect(out).not.toHaveProperty('notes');
  });

  it('order item', () => {
    const row = { ...secrets, id: '1', productName: 'p', unitPriceMinor: 1, quantity: 1, lineTotalMinor: 1, sku: 'x', productId: 'p' };
    expectExact(s.serializeOrderItem(row), s.portalOrderItemFields);
  });

  it('order history', () => {
    const row = { ...secrets, id: '1', toStatus: 'x', createdAt: now, fromStatus: 'y', note: 'n', changedBy: 'u' };
    const out = s.serializeOrderHistory(row);
    expectExact(out, s.portalOrderHistoryFields);
    expect(out).not.toHaveProperty('note');
  });

  it('invoice', () => {
    const row = {
      ...secrets,
      notes: 'internal',
      id: '1',
      invoiceNumber: 1,
      status: 'paid',
      currency: 'USD',
      totalMinor: 1,
      paidMinor: 1,
      issueDate: '2026-01-01',
      dueDate: '2026-02-01',
      orderId: 'o',
      orderNumber: 2,
      customerName: 'x',
    };
    const out = s.serializeInvoice(row);
    expectExact(out, s.portalInvoiceFields);
    expect(out).not.toHaveProperty('notes');
  });

  it('payment', () => {
    const row = { ...secrets, id: '1', amountMinor: 1, method: 'cash', paidAt: now, idempotencyKey: 'k' };
    const out = s.serializePayment(row, 5);
    expectExact(out, s.portalPaymentFields);
    expect(out.refundedMinor).toBe(5);
  });

  it('ticket', () => {
    const row = { ...secrets, id: '1', ticketNumber: 1, subject: 's', status: 'open', createdAt: now, updatedAt: now, customerName: 'c', source: 'portal' };
    expectExact(s.serializeTicket(row), s.portalTicketFields);
  });

  it('ticket message', () => {
    const row = { ...secrets, id: '1', authorType: 'staff', body: 'b', createdAt: now, authorUserId: 'u' };
    expectExact(s.serializeTicketMessage(row), s.portalTicketMessageFields);
  });

  it('notice', () => {
    const row = { ...secrets, id: '1', title: 't', body: 'b', publishedAt: now, expiresAt: null };
    expectExact(s.serializeNotice(row), s.portalNoticeFields);
  });

  it('document', () => {
    const row = { ...secrets, id: '1', name: 'n', fileName: 'f', mimeType: 'm', sizeBytes: 1, createdAt: now };
    expectExact(s.serializeDocument(row), s.portalDocumentFields);
  });

  it('appointment (notes is public, staffNotes/assignedTo are not)', () => {
    const row = { ...secrets, id: '1', subject: 's', notes: 'mine', startsAt: now, durationMinutes: 30, status: 'requested', createdAt: now, updatedAt: now };
    const out = s.serializeAppointment(row);
    expectExact(out, s.portalAppointmentFields);
    expect(out.notes).toBe('mine');
  });

  it('nested items and payments stay clean', () => {
    const item = s.serializeOrderItem({ ...secrets, id: '1', productName: 'p', unitPriceMinor: 1, quantity: 1, lineTotalMinor: 1 });
    const pay = s.serializePayment({ ...secrets, id: '2', amountMinor: 1, method: 'cash', paidAt: now }, 0);
    expectExact(item, s.portalOrderItemFields);
    expectExact(pay, s.portalPaymentFields);
  });
});
