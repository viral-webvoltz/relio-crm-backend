const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value: string | number) => String(value).replace(/[&<>"']/g, (c) => entities[c] ?? c);

// Header values must never carry line breaks (header injection).
export const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export const money = (minor: number, currency: string) => {
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(minor / 10 ** digits);
};

export const templateKeys = ['invoice', 'quote', 'ticket_reply', 'ticket_received'] as const;
export type TemplateKey = (typeof templateKeys)[number];
export type TemplateContent = { subject: string; bodyHtml: string; bodyText: string };

export const MAX_SUBJECT = 200;
export const MAX_BODY = 20_000;

// Fixed allow-list per key: a template may only use these placeholders.
export const templateVariables: Record<TemplateKey, readonly string[]> = {
  invoice: ['invoice_number', 'due_date', 'total', 'balance', 'customer_name', 'items'],
  quote: ['quote_number', 'customer_name', 'total', 'valid_until', 'link', 'items'],
  ticket_reply: ['ticket_number', 'subject', 'reply_body', 'customer_name'],
  ticket_received: ['ticket_number', 'subject'],
};

export const defaultTemplates: Record<TemplateKey, TemplateContent> = {
  invoice: {
    subject: 'Invoice #{{invoice_number}}',
    bodyHtml: `<p>Hello {{customer_name}},</p>
<p>Invoice #{{invoice_number}} is due on {{due_date}}.</p>
<div style="white-space:pre-line">{{items}}</div>
<p><strong>Total:</strong> {{total}}<br><strong>Balance due:</strong> {{balance}}</p>`,
    bodyText: `Hello {{customer_name}},

Invoice #{{invoice_number}} is due on {{due_date}}.

{{items}}

Total: {{total}}
Balance due: {{balance}}`,
  },
  quote: {
    subject: 'Quote #{{quote_number}}',
    bodyHtml: `<p>Hello {{customer_name}},</p>
<p>Here is quote #{{quote_number}}, valid until {{valid_until}}.</p>
<div style="white-space:pre-line">{{items}}</div>
<p><strong>Total:</strong> {{total}}</p>
<p><a href="{{link}}">Review and accept the quote</a></p>`,
    bodyText: `Hello {{customer_name}},

Here is quote #{{quote_number}}, valid until {{valid_until}}.

{{items}}

Total: {{total}}

Review and accept the quote: {{link}}`,
  },
  ticket_reply: {
    subject: 'Re: [#{{ticket_number}}] {{subject}}',
    bodyHtml: `<p>There is a new reply on your support ticket #{{ticket_number}} ({{subject}}):</p>
<blockquote style="white-space:pre-wrap">{{reply_body}}</blockquote>`,
    bodyText: `There is a new reply on your support ticket #{{ticket_number}} ({{subject}}):

{{reply_body}}`,
  },
  ticket_received: {
    subject: 'Re: [#{{ticket_number}}] {{subject}}',
    bodyHtml: `<p>We received your message and opened support ticket #{{ticket_number}} ({{subject}}). We will get back to you soon.</p>
<p>Reply to this email to add more information.</p>`,
    bodyText: `We received your message and opened support ticket #{{ticket_number}} ({{subject}}). We will get back to you soon.

Reply to this email to add more information.`,
  },
};

const placeholder = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Placeholder names used in a template that are not in the allow-list.
export function unknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const names = [...template.matchAll(placeholder)].map((m) => m[1] ?? '');
  return [...new Set(names.filter((n) => !allowed.includes(n)))];
}

// Plain string substitution (no eval, no nested lookups); values are never re-scanned for placeholders.
function fill(template: string, vars: Record<string, string>, transform: (v: string) => string) {
  return template.replace(placeholder, (_m, name: string) => transform(Object.hasOwn(vars, name) ? (vars[name] ?? '') : ''));
}

// Fills any content (a stored template, a campaign) using only the allowed placeholder names.
export function renderWith(content: TemplateContent, allowed: readonly string[], vars: Record<string, string | number | null | undefined>) {
  const clean: Record<string, string> = {};
  for (const name of allowed) clean[name] = String(vars[name] ?? '');
  return {
    subject: oneLine(fill(content.subject, clean, oneLine)).slice(0, MAX_SUBJECT),
    html: fill(content.bodyHtml, clean, esc),
    text: fill(content.bodyText, clean, (v) => v),
  };
}

export const renderTemplate = (content: TemplateContent, key: TemplateKey, vars: Record<string, string | number | null | undefined>) =>
  renderWith(content, templateVariables[key], vars);

export type InvoiceMail = {
  invoiceNumber: number;
  customerName: string | null;
  currency: string;
  dueDate: string;
  totalMinor: number;
  outstandingMinor: number;
  items: { productName: string; quantity: number; lineTotalMinor: number }[];
};

export function invoiceVariables(inv: InvoiceMail) {
  const m = (minor: number) => money(minor, inv.currency);
  return {
    invoice_number: inv.invoiceNumber,
    due_date: inv.dueDate,
    total: m(inv.totalMinor),
    balance: m(inv.outstandingMinor),
    customer_name: inv.customerName ?? 'there',
    items: inv.items.map((i) => `${i.productName} x ${i.quantity}: ${m(i.lineTotalMinor)}`).join('\n'),
  };
}

export const SAMPLE_VARIABLES: Record<TemplateKey, Record<string, string | number>> = {
  invoice: {
    invoice_number: 1042,
    due_date: '2026-12-01',
    total: '$120.00',
    balance: '$120.00',
    customer_name: 'Alex Example',
    items: 'Widget x 2: $80.00\nGadget x 1: $40.00',
  },
  quote: {
    quote_number: 1042,
    customer_name: 'Alex Example',
    total: '$120.00',
    valid_until: '2026-12-01',
    link: 'https://app.example.com/quote/0123456789abcdef',
    items: 'Widget x 2: $80.00\nGadget x 1: $40.00',
  },
  ticket_reply: {
    ticket_number: 57,
    subject: 'Cannot log in',
    reply_body: 'Thanks for reaching out. Please try resetting your password.',
    customer_name: 'Alex Example',
  },
  ticket_received: { ticket_number: 57, subject: 'Cannot log in' },
};
