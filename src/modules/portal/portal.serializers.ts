// Every portal response goes through one of these. Fields are copied one by one (never spread), so a new
// database column can not reach a customer unless it is added here on purpose. The *Fields lists are the
// public contract; a contract check can compare them to the serializer output.

export const portalProfileFields = ['name', 'firstName', 'lastName', 'phone', 'email', 'organizationName', 'mustChangePassword'] as const;
export const portalOrderFields = ['id', 'orderNumber', 'status', 'currency', 'subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor', 'createdAt'] as const;
export const portalOrderItemFields = ['id', 'productName', 'unitPriceMinor', 'quantity', 'lineTotalMinor'] as const;
export const portalOrderHistoryFields = ['id', 'toStatus', 'createdAt'] as const;
export const portalInvoiceFields = [
  'id',
  'invoiceNumber',
  'status',
  'currency',
  'totalMinor',
  'paidMinor',
  'issueDate',
  'dueDate',
  'orderId',
  'orderNumber',
] as const;
export const portalPaymentFields = ['id', 'amountMinor', 'method', 'paidAt', 'refundedMinor'] as const;
export const portalTicketFields = ['id', 'ticketNumber', 'subject', 'status', 'createdAt', 'updatedAt'] as const;
export const portalTicketMessageFields = ['id', 'authorType', 'body', 'createdAt'] as const;

export function serializeProfile(p: {
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string;
  organizationName: string;
  mustChangePassword?: boolean;
}) {
  return {
    name: [p.firstName, p.lastName].filter(Boolean).join(' '),
    firstName: p.firstName,
    lastName: p.lastName,
    phone: p.phone,
    email: p.email,
    organizationName: p.organizationName,
    mustChangePassword: p.mustChangePassword ?? false,
  };
}

export function serializeOrder(o: {
  id: string;
  orderNumber: number;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  createdAt: Date;
}) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    currency: o.currency,
    subtotalMinor: o.subtotalMinor,
    discountMinor: o.discountMinor,
    taxMinor: o.taxMinor,
    totalMinor: o.totalMinor,
    createdAt: o.createdAt,
  };
}

export function serializeOrderItem(i: { id: string; productName: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }) {
  return { id: i.id, productName: i.productName, unitPriceMinor: i.unitPriceMinor, quantity: i.quantity, lineTotalMinor: i.lineTotalMinor };
}

export function serializeOrderHistory(h: { id: string; toStatus: string; createdAt: Date }) {
  return { id: h.id, toStatus: h.toStatus, createdAt: h.createdAt };
}

export function serializeInvoice(i: {
  id: string;
  invoiceNumber: number;
  status: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  issueDate: string;
  dueDate: string;
  orderId: string;
  orderNumber: number;
}) {
  return {
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    status: i.status,
    currency: i.currency,
    totalMinor: i.totalMinor,
    paidMinor: i.paidMinor,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    orderId: i.orderId,
    orderNumber: i.orderNumber,
  };
}

export function serializePayment(p: { id: string; amountMinor: number; method: string; paidAt: Date }, refundedMinor: number) {
  return { id: p.id, amountMinor: p.amountMinor, method: p.method, paidAt: p.paidAt, refundedMinor };
}

export function serializeTicket(t: { id: string; ticketNumber: number; subject: string; status: string; createdAt: Date; updatedAt: Date }) {
  return { id: t.id, ticketNumber: t.ticketNumber, subject: t.subject, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

export function serializeTicketMessage(m: { id: string; authorType: string; body: string; createdAt: Date }) {
  return { id: m.id, authorType: m.authorType, body: m.body, createdAt: m.createdAt };
}

export const portalNoticeFields = ['id', 'title', 'body', 'publishedAt', 'expiresAt'] as const;
export const portalDocumentFields = ['id', 'name', 'fileName', 'mimeType', 'sizeBytes', 'createdAt'] as const;
// assigned_to and staff_notes are internal and stay out.
export const portalAppointmentFields = ['id', 'subject', 'notes', 'startsAt', 'durationMinutes', 'status', 'createdAt', 'updatedAt'] as const;

export function serializeNotice(n: { id: string; title: string; body: string; publishedAt: Date | null; expiresAt: Date | null }) {
  return { id: n.id, title: n.title, body: n.body, publishedAt: n.publishedAt, expiresAt: n.expiresAt };
}

export function serializeDocument(d: { id: string; name: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: Date }) {
  return { id: d.id, name: d.name, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, createdAt: d.createdAt };
}

export function serializeAppointment(a: {
  id: string;
  subject: string;
  notes: string | null;
  startsAt: Date;
  durationMinutes: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: a.id,
    subject: a.subject,
    notes: a.notes,
    startsAt: a.startsAt,
    durationMinutes: a.durationMinutes,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
