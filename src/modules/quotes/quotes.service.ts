import { randomBytes } from 'node:crypto';
import { env } from '@/config/env.js';
import { withTransaction, type DbTransaction } from '@/config/database.js';
import { quotes } from '@/database/schema/index.js';
import { hashToken } from '@/modules/auth/auth.service.js';
import { invoicesService } from '@/modules/invoices/invoices.service.js';
import { activeUserEmails, canSendMail, queueEmail } from '@/modules/mail/mail.service.js';
import { emailTemplatesService } from '@/modules/mail/email-templates.service.js';
import { money } from '@/modules/mail/mail.templates.js';
import { calculateTotals, type Discount } from '@/modules/orders/orders.totals.js';
import { ordersService } from '@/modules/orders/orders.service.js';
import { enqueueWebhookEvent } from '@/modules/webhooks/webhooks.dispatcher.js';
import { enqueueWorkflowEvent } from '@/modules/workflows/workflows.events.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { quotesRepository } from './quotes.repository.js';
import type {
  AcceptQuoteInput,
  ConvertQuoteInput,
  CreateQuoteInput,
  QuoteListQuery,
  RejectQuoteInput,
  SendQuoteInput,
  UpdateQuoteInput,
} from './quotes.validation.js';

const DEFAULT_VALID_DAYS = 30;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const fullName = (c: { firstName: string; lastName: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(' ');

type QuoteRow = typeof quotes.$inferSelect;
type Line = { productId: string; productName: string; sku: string | null; description: string | null; unitPriceMinor: number; quantity: number };
type Customer = { contactId: string | null; companyId: string | null; customerName: string | null };

const isExpired = (quote: Pick<QuoteRow, 'status' | 'validUntil'>) => quote.status === 'sent' && quote.validUntil !== null && quote.validUntil < today();

// What the API returns: the stored row without the link hash, and "expired" folded into the status.
function present({ publicTokenHash: _hash, ...quote }: QuoteRow) {
  return { ...quote, status: isExpired(quote) ? 'expired' : quote.status };
}

const discountOf = (q: Pick<QuoteRow, 'discountType' | 'discountValue'>): Discount | null =>
  q.discountType === 'percent' || q.discountType === 'fixed' ? ({ type: q.discountType, value: q.discountValue ?? 0 } as Discount) : null;

class QuotesService {
  async list({ organizationId, query }: { organizationId: string; query: QuoteListQuery }) {
    const { rows, total } = await quotesRepository.list({ organizationId, query });
    return { rows: rows.map(present), total };
  }

  async getById({ organizationId, id }: { organizationId: string; id: string }) {
    const quote = await quotesRepository.findById({ organizationId, id });
    if (!quote) throw new NotFoundError('Quote not found');
    const [items, orderNumber] = await Promise.all([
      quotesRepository.findItems({ quoteId: id }),
      quote.convertedOrderId ? quotesRepository.findOrderNumber({ id: quote.convertedOrderId }) : null,
    ]);
    return { ...present(quote), items, orderNumber };
  }

  create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateQuoteInput }) {
    return withTransaction(async (tx) => {
      const customer = await this.resolveCustomer(tx, organizationId, input);
      if (input.dealId && !(await quotesRepository.dealExists({ organizationId, id: input.dealId }, tx))) {
        throw new BadRequestError('Deal not found', 'INVALID_DEAL');
      }
      const { lines, currency } = await this.resolveLines(tx, organizationId, input.items);
      const totals = this.totals(lines, input.discount, input.taxRateBps);
      const quoteNumber = await quotesRepository.nextQuoteNumber({ organizationId }, tx);
      const quote = await quotesRepository.insert(
        {
          organizationId,
          quoteNumber,
          ...customer,
          dealId: input.dealId,
          currency,
          ...totals,
          discountType: input.discount?.type,
          discountValue: input.discount?.value,
          taxRateBps: input.taxRateBps,
          validUntil: input.validUntil,
          notes: input.notes,
          terms: input.terms,
          createdBy: userId,
        },
        tx,
      );
      await quotesRepository.insertItems(this.itemRows(organizationId, quote.id, lines), tx);
      return present(quote);
    });
  }

  // A draft or sent quote can be edited. Editing a sent quote takes it back to draft and kills the old link, so the customer can never
  // accept terms that are no longer the current ones; send it again to issue a new link.
  update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateQuoteInput }) {
    return withTransaction(async (tx) => {
      const quote = await this.lock(tx, organizationId, id);
      if (quote.status !== 'draft' && quote.status !== 'sent') throw new ConflictError(`A ${quote.status} quote can no longer be edited`, 'QUOTE_LOCKED');

      const customer =
        'contactId' in input || 'companyId' in input
          ? await this.resolveCustomer(tx, organizationId, { contactId: input.contactId ?? null, companyId: input.companyId ?? null })
          : {};
      if (input.dealId && !(await quotesRepository.dealExists({ organizationId, id: input.dealId }, tx))) {
        throw new BadRequestError('Deal not found', 'INVALID_DEAL');
      }

      let lines: Line[];
      let currency = quote.currency;
      if (input.items) {
        ({ lines, currency } = await this.resolveLines(tx, organizationId, input.items));
      } else {
        lines = (await quotesRepository.findItems({ quoteId: id }, tx)).map(({ productId, productName, sku, description, unitPriceMinor, quantity }) => ({
          productId,
          productName,
          sku,
          description,
          unitPriceMinor,
          quantity,
        }));
      }
      const discount = input.discount === undefined ? discountOf(quote) : input.discount;
      const taxRateBps = input.taxRateBps ?? quote.taxRateBps;
      const totals = this.totals(lines, discount, taxRateBps);

      if (input.items) {
        await quotesRepository.deleteItems({ quoteId: id }, tx);
        await quotesRepository.insertItems(this.itemRows(organizationId, id, lines), tx);
      }
      const updated = await quotesRepository.update(
        {
          id,
          set: {
            ...customer,
            ...(input.dealId !== undefined && { dealId: input.dealId }),
            ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
            ...(input.notes !== undefined && { notes: input.notes }),
            ...(input.terms !== undefined && { terms: input.terms }),
            currency,
            ...totals,
            discountType: discount?.type ?? null,
            discountValue: discount?.value ?? null,
            taxRateBps,
            ...(quote.status === 'sent' && { status: 'draft', publicTokenHash: null, sentAt: null }),
          },
        },
        tx,
      );
      return present(updated);
    });
  }

  async remove({ organizationId, id }: { organizationId: string; id: string }) {
    await withTransaction(async (tx) => {
      const quote = await this.lock(tx, organizationId, id);
      if (quote.status !== 'draft' && quote.status !== 'rejected') throw new ConflictError('Only a draft or rejected quote can be deleted', 'QUOTE_LOCKED');
      await quotesRepository.remove({ id }, tx);
    });
  }

  // Issues a fresh customer link (any earlier link stops working) and, when there is an address, emails it. The link is only
  // ever returned here: just its hash is stored.
  async send({ organizationId, userId, id, input }: { organizationId: string; userId: string; id: string; input: SendQuoteInput }) {
    const token = randomBytes(32).toString('hex');
    const { quote, items, recipient } = await withTransaction(async (tx) => {
      const quote = await this.lock(tx, organizationId, id);
      if (quote.status !== 'draft' && quote.status !== 'sent') throw new ConflictError(`A ${quote.status} quote cannot be sent again`, 'QUOTE_LOCKED');
      if (quote.validUntil && quote.validUntil < today()) throw new BadRequestError('The valid-until date has passed; extend it first', 'QUOTE_EXPIRED');

      const contact = quote.contactId ? await quotesRepository.findContact({ organizationId, id: quote.contactId }, tx) : undefined;
      // An override may only be the quote contact or a colleague, so the endpoint cannot mail quotes to arbitrary outsiders.
      if (input.to && input.to.toLowerCase() !== contact?.email?.toLowerCase() && (await activeUserEmails(organizationId, [input.to])).length === 0) {
        throw new BadRequestError('Recipient must be the quote contact or a user of this organization', 'RECIPIENT_NOT_ALLOWED');
      }
      const updated = await quotesRepository.update(
        { id, set: { status: 'sent', publicTokenHash: hashToken(token), sentAt: new Date(), validUntil: quote.validUntil ?? addDays(DEFAULT_VALID_DAYS) } },
        tx,
      );
      await audit({ organizationId, actorUserId: userId, action: 'quote.sent', targetType: 'quote', targetId: id }, tx);
      return { quote: updated, items: await quotesRepository.findItems({ quoteId: id }, tx), recipient: input.to ?? contact?.email ?? null };
    });

    const link = `${env.APP_URL.replace(/\/$/, '')}/quote/${token}`;
    let emailQueued = false;
    if (recipient && (await canSendMail(organizationId))) {
      const m = (minor: number) => money(minor, quote.currency);
      const mail = await emailTemplatesService.render(organizationId, 'quote', {
        quote_number: quote.quoteNumber,
        customer_name: quote.customerName ?? 'there',
        total: m(quote.totalMinor),
        valid_until: quote.validUntil,
        link,
        items: items.map((i) => `${i.productName} x ${i.quantity}: ${m(i.lineTotalMinor)}`).join('\n'),
      });
      emailQueued = await queueEmail({ organizationId, kind: 'quote', to: recipient, ...mail, relatedType: 'quote', relatedId: id });
    }
    return { quote: present(quote), link, emailQueued };
  }

  // Turns an accepted quote into an order (and optionally its invoice) in one transaction, at the prices that were quoted.
  // If anything fails (stock, an inactive product) nothing is created and the quote stays accepted, ready to retry.
  convert({ organizationId, userId, id, input }: { organizationId: string; userId: string; id: string; input: ConvertQuoteInput }) {
    return withTransaction(async (tx) => {
      const quote = await this.lock(tx, organizationId, id);
      if (quote.convertedOrderId) throw new ConflictError('This quote was already converted', 'ALREADY_CONVERTED');
      if (quote.status !== 'accepted') throw new ConflictError('Only an accepted quote can be converted', 'NOT_ACCEPTED');

      const items = await quotesRepository.findItems({ quoteId: id }, tx);
      const order = await ordersService.createIn(tx, {
        organizationId,
        userId,
        input: {
          contactId: quote.contactId,
          companyId: quote.companyId,
          items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
          discount: discountOf(quote),
          taxRateBps: quote.taxRateBps,
          notes: `From quote #${quote.quoteNumber}`,
        },
        unitPrices: new Map(items.map((i) => [i.productId, i.unitPriceMinor])),
      });
      // The customer agreed to this total; never create an order that differs from it.
      if (order.totalMinor !== quote.totalMinor) throw new ConflictError('The order total would differ from the quote', 'TOTAL_MISMATCH');

      const invoice =
        input.target === 'invoice'
          ? await invoicesService.createIn(tx, { organizationId, userId, input: { orderId: order.id, dueDate: input.dueDate, notes: null } })
          : null;
      const updated = await quotesRepository.update({ id, set: { convertedOrderId: order.id, convertedAt: new Date() } }, tx);
      await audit(
        {
          organizationId,
          actorUserId: userId,
          action: 'quote.converted',
          targetType: 'quote',
          targetId: id,
          metadata: { orderId: order.id, invoiceId: invoice?.id ?? null },
        },
        tx,
      );
      return { quote: present(updated), order, invoice };
    });
  }

  // ---- the customer side: the link is the credential, so everything here is looked up by the hash of the token ----

  async publicView(token: string) {
    const found = await quotesRepository.findByTokenHash({ tokenHash: hashToken(token) });
    if (!found) throw new NotFoundError('Quote not found');
    return this.publicShape(found.quote, found.organizationName);
  }

  accept(token: string, input: AcceptQuoteInput) {
    return this.respond(token, 'accepted', input.name, input.note ?? null);
  }

  reject(token: string, input: RejectQuoteInput) {
    return this.respond(token, 'rejected', null, input.note ?? null);
  }

  private async respond(token: string, status: 'accepted' | 'rejected', name: string | null, note: string | null) {
    const tokenHash = hashToken(token);
    const quote = await quotesRepository.respond({ tokenHash, status, name, note });
    if (!quote) {
      const found = await quotesRepository.findByTokenHash({ tokenHash });
      if (!found) throw new NotFoundError('Quote not found');
      if (isExpired(found.quote)) throw new ConflictError('This quote has expired', 'QUOTE_EXPIRED');
      throw new ConflictError(`This quote was already ${found.quote.status}`, 'ALREADY_RESPONDED');
    }
    const { publicTokenHash: _hash, ...safe } = quote;
    const event = `quotes.${status}`;
    await audit({
      organizationId: quote.organizationId,
      action: `quote.${status}`,
      targetType: 'quote',
      targetId: quote.id,
      metadata: { by: name, note },
    });
    void enqueueWebhookEvent({
      organizationId: quote.organizationId,
      event,
      data: { id: quote.id, quoteNumber: quote.quoteNumber, totalMinor: quote.totalMinor },
    });
    // A workflow event needs an actor to run as; a quote whose creator was deleted has none, so it only fires the webhook.
    if (quote.createdBy) {
      void enqueueWorkflowEvent({
        organizationId: quote.organizationId,
        actorId: quote.createdBy,
        event,
        id: quote.id,
        values: safe,
        changed: ['status'],
        depth: 0,
      });
      void quotesRepository
        .notify({
          organizationId: quote.organizationId,
          userId: quote.createdBy,
          type: 'quote',
          title: `Quote #${quote.quoteNumber} ${status}${name ? ` by ${name}` : ''}`,
          body: note,
          link: `/quotes/${quote.id}`,
          relatedType: 'quote',
          relatedId: quote.id,
        })
        .catch(() => undefined);
    }
    const found = await quotesRepository.findByTokenHash({ tokenHash });
    return this.publicShape(quote, found?.organizationName ?? '');
  }

  // Only what the customer should see: no internal ids, no creator, no link hash.
  private async publicShape(quote: QuoteRow, organizationName: string) {
    const items = await quotesRepository.findItems({ quoteId: quote.id });
    const status = isExpired(quote) ? 'expired' : quote.status;
    return {
      quoteNumber: quote.quoteNumber,
      status,
      canRespond: status === 'sent',
      organizationName,
      customerName: quote.customerName,
      currency: quote.currency,
      validUntil: quote.validUntil,
      subtotalMinor: quote.subtotalMinor,
      discountMinor: quote.discountMinor,
      taxMinor: quote.taxMinor,
      taxRateBps: quote.taxRateBps,
      totalMinor: quote.totalMinor,
      notes: quote.notes,
      terms: quote.terms,
      respondedAt: quote.respondedAt,
      respondedByName: quote.respondedByName,
      items: items.map((i) => ({
        name: i.productName,
        description: i.description,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        lineTotalMinor: i.lineTotalMinor,
      })),
    };
  }

  // ---- helpers ----

  private async lock(tx: DbTransaction, organizationId: string, id: string) {
    const quote = await quotesRepository.lockById({ organizationId, id }, tx);
    if (!quote) throw new NotFoundError('Quote not found');
    return quote;
  }

  private totals(lines: Line[], discount: Discount | null | undefined, taxRateBps: number) {
    try {
      return calculateTotals(lines, discount, taxRateBps);
    } catch {
      throw new BadRequestError('The discount is larger than the quote subtotal', 'DISCOUNT_TOO_LARGE');
    }
  }

  private itemRows(organizationId: string, quoteId: string, lines: Line[]) {
    return lines.map((line, position) => ({ ...line, organizationId, quoteId, position, lineTotalMinor: line.unitPriceMinor * line.quantity }));
  }

  private async resolveCustomer(tx: DbTransaction, organizationId: string, input: { contactId?: string | null; companyId?: string | null }): Promise<Customer> {
    let customerName: string | null = null;
    if (input.contactId) {
      const contact = await quotesRepository.findContact({ organizationId, id: input.contactId }, tx);
      if (!contact) throw new BadRequestError('Contact not found', 'INVALID_CONTACT');
      customerName = fullName(contact);
    }
    if (input.companyId) {
      const company = await quotesRepository.findCompanyName({ organizationId, id: input.companyId }, tx);
      if (!company) throw new BadRequestError('Company not found', 'INVALID_COMPANY');
      customerName ??= company.name;
    }
    return { contactId: input.contactId ?? null, companyId: input.companyId ?? null, customerName };
  }

  // Products must exist, be active and share one currency. Name and SKU are snapshotted; the price is the offered one.
  private async resolveLines(tx: DbTransaction, organizationId: string, items: CreateQuoteInput['items']) {
    const found = await quotesRepository.findProducts({ organizationId, ids: items.map((i) => i.productId) }, tx);
    const byId = new Map(found.map((p) => [p.id, p]));
    const lines: Line[] = items.map((item) => {
      const product = byId.get(item.productId);
      if (!product) throw new BadRequestError('A product in this quote does not exist', 'INVALID_PRODUCT');
      if (!product.isActive) throw new ConflictError(`"${product.name}" is not available`, 'PRODUCT_INACTIVE');
      return {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        description: item.description ?? null,
        unitPriceMinor: item.unitPriceMinor ?? product.priceMinor,
        quantity: item.quantity,
      };
    });
    const currencies = new Set(found.map((p) => p.currency));
    const [currency] = currencies;
    if (!currency) throw new BadRequestError('A quote needs at least one item', 'INVALID_PRODUCT');
    if (currencies.size > 1) throw new BadRequestError('All products in a quote must use the same currency', 'MIXED_CURRENCY');
    return { lines, currency };
  }
}

export const quotesService = new QuotesService();
