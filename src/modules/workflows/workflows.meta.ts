type FieldType = 'text' | 'number' | 'enum' | 'user' | 'stage';
type Field = { key: string; label: string; type: FieldType; options?: string[] };
type Trigger = { event: string; label: string; fields: Field[]; timed?: true }; // timed: fired by the scheduler; the trigger step may carry `at` (HH:MM), `timezone` (IANA, default UTC) and, for the weekly one, `day` (sun..sat, default mon)

const priorities = ['low', 'medium', 'high'];

const leadFields: Field[] = [
  { key: 'firstName', label: 'First name', type: 'text' },
  { key: 'lastName', label: 'Last name', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'companyName', label: 'Company', type: 'text' },
  { key: 'source', label: 'Source', type: 'enum', options: ['website', 'referral', 'social', 'email', 'event', 'other'] },
  { key: 'status', label: 'Status', type: 'enum', options: ['new', 'contacted', 'qualified', 'unqualified', 'converted'] },
  { key: 'priority', label: 'Priority', type: 'enum', options: priorities },
  { key: 'score', label: 'Score', type: 'number' },
  { key: 'assignedTo', label: 'Assigned to', type: 'user' },
];
const dealFields: Field[] = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'stageId', label: 'Stage', type: 'stage' },
  { key: 'valueMinor', label: 'Value (minor units)', type: 'number' },
  { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'ownerId', label: 'Owner', type: 'user' },
  { key: 'lostReason', label: 'Lost reason', type: 'text' },
];
const contactFields: Field[] = [
  { key: 'firstName', label: 'First name', type: 'text' },
  { key: 'lastName', label: 'Last name', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'jobTitle', label: 'Job title', type: 'text' },
];
const companyFields: Field[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'website', label: 'Website', type: 'text' },
  { key: 'industry', label: 'Industry', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
];
const taskFields: Field[] = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'priority', label: 'Priority', type: 'enum', options: priorities },
  { key: 'status', label: 'Status', type: 'enum', options: ['open', 'done'] },
  { key: 'assignedTo', label: 'Assigned to', type: 'user' },
];
const ticketFields: Field[] = [
  { key: 'subject', label: 'Subject', type: 'text' },
  { key: 'status', label: 'Status', type: 'enum', options: ['open', 'pending', 'resolved', 'closed'] },
  { key: 'priority', label: 'Priority', type: 'enum', options: [...priorities, 'urgent'] },
  { key: 'assignedTo', label: 'Assigned to', type: 'user' },
];

const invoiceFields: Field[] = [
  { key: 'invoiceNumber', label: 'Invoice number', type: 'number' },
  { key: 'status', label: 'Status', type: 'enum', options: ['unpaid', 'partial'] },
  { key: 'customerName', label: 'Customer', type: 'text' },
  { key: 'totalMinor', label: 'Total (minor units)', type: 'number' },
  { key: 'paidMinor', label: 'Paid (minor units)', type: 'number' },
  { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'dueDate', label: 'Due date', type: 'text' },
];
const quoteFields: Field[] = [
  { key: 'quoteNumber', label: 'Quote number', type: 'number' },
  { key: 'status', label: 'Status', type: 'enum', options: ['draft', 'sent', 'accepted', 'rejected'] },
  { key: 'customerName', label: 'Customer', type: 'text' },
  { key: 'totalMinor', label: 'Total (minor units)', type: 'number' },
  { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'validUntil', label: 'Valid until', type: 'text' },
];
const subscriptionFields: Field[] = [
  { key: 'name', label: 'Subscription', type: 'text' },
  { key: 'customerName', label: 'Customer', type: 'text' },
  { key: 'totalMinor', label: 'Invoice total (minor units)', type: 'number' },
  { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'invoiceNumber', label: 'Invoice number', type: 'number' },
];
const dateField: Field[] = [{ key: 'date', label: 'Date (YYYY-MM-DD)', type: 'text' }];

// Event names are the audit/webhook names: <route>.<action>. "tickets.messages" is a reply on a ticket.
// Task completion is tasks.update with a "status equals done" condition.
export const triggers: Trigger[] = [
  { event: 'leads.create', label: 'Lead created', fields: leadFields },
  { event: 'leads.update', label: 'Lead updated', fields: leadFields },
  { event: 'leads.convert', label: 'Lead converted', fields: leadFields },
  { event: 'deals.create', label: 'Deal created', fields: dealFields },
  { event: 'deals.update', label: 'Deal updated', fields: dealFields },
  { event: 'deals.stage', label: 'Deal stage changed', fields: dealFields },
  { event: 'contacts.create', label: 'Contact created', fields: contactFields },
  { event: 'contacts.update', label: 'Contact updated', fields: contactFields },
  { event: 'companies.create', label: 'Company created', fields: companyFields },
  { event: 'companies.update', label: 'Company updated', fields: companyFields },
  { event: 'tasks.create', label: 'Task created', fields: taskFields },
  { event: 'tasks.update', label: 'Task updated', fields: taskFields },
  { event: 'tickets.create', label: 'Ticket created', fields: ticketFields },
  { event: 'tickets.update', label: 'Ticket updated', fields: ticketFields },
  { event: 'tickets.messages', label: 'Ticket reply', fields: ticketFields },
  { event: 'tickets.sla_warning', label: 'Ticket close to its SLA deadline', fields: ticketFields },
  { event: 'tickets.sla_breached', label: 'Ticket breached its SLA', fields: ticketFields },
  { event: 'tickets.first_response_breached', label: 'Ticket missed its first-reply target', fields: ticketFields },
  { event: 'subscriptions.invoiced', label: 'Subscription invoiced', fields: subscriptionFields },
  { event: 'quotes.create', label: 'Quote created', fields: quoteFields },
  { event: 'quotes.send', label: 'Quote sent', fields: quoteFields },
  { event: 'quotes.accepted', label: 'Quote accepted by customer', fields: quoteFields },
  { event: 'quotes.rejected', label: 'Quote declined by customer', fields: quoteFields },
  { event: 'quotes.convert', label: 'Quote converted to order', fields: quoteFields },
  { event: 'schedule.daily', label: 'Every day', fields: dateField, timed: true },
  { event: 'schedule.weekly', label: 'Every week', fields: dateField, timed: true },
  { event: 'tasks.overdue', label: 'Task became overdue', fields: taskFields, timed: true },
  { event: 'invoices.overdue', label: 'Invoice became overdue', fields: invoiceFields, timed: true },
];
