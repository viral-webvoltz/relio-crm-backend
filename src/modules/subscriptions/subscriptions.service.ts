import { withTransaction, type DbTransaction } from '@/config/database.js';
import { subscriptions } from '@/database/schema/index.js';
import { invoicesService } from '@/modules/invoices/invoices.service.js';
import { canSendMail, mailService } from '@/modules/mail/mail.service.js';
import { ordersService } from '@/modules/orders/orders.service.js';
import { calculateTotals, type Discount } from '@/modules/orders/orders.totals.js';
import { quotesRepository } from '@/modules/quotes/quotes.repository.js';
import { enqueueWebhookEvent } from '@/modules/webhooks/webhooks.dispatcher.js';
import { notifyWorkflowOwners, runAsResolver } from '@/modules/workflows/workflows.runas.js';
import { enqueueWorkflowEvent } from '@/modules/workflows/workflows.events.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { logger } from '@/shared/utils/logger.js';
import { subscriptionsRepository } from './subscriptions.repository.js';
import { addDays, cycleFrom, localDate, nextRunOn, type IntervalUnit } from './subscriptions.schedule.js';
import type { CreateSubscriptionInput, SubscriptionListQuery, UpdateSubscriptionInput } from './subscriptions.validation.js';

const MAX_FAILURES = 3;
const SCAN_BATCH = 50;
const UPCOMING = 5;
const fullName = (c: { firstName: string; lastName: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(' ');

type Sub = typeof subscriptions.$inferSelect;
type Line = { productId: string; productName: string; quantity: number; unitPriceMinor: number };

const discountOf = (s: Pick<Sub, 'discountType' | 'discountValue'>): Discount | null =>
  s.discountType === 'percent' || s.discountType === 'fixed' ? ({ type: s.discountType, value: s.discountValue ?? 0 } as Discount) : null;

const scheduleOf = (s: Sub, cycle = s.cycle, runCount = s.runCount) =>
  nextRunOn({ startOn: s.startOn, unit: s.intervalUnit as IntervalUnit, every: s.intervalCount, cycle, runCount, endOn: s.endOn, maxRuns: s.maxRuns });

class SubscriptionsService {
  async list({ organizationId, query }: { organizationId: string; query: SubscriptionListQuery }) {
    return subscriptionsRepository.list({ organizationId, query });
  }

  async getById({ organizationId, id }: { organizationId: string; id: string }) {
    const sub = await this.find(organizationId, id);
    const items = await subscriptionsRepository.findItems({ subscriptionId: id });
    // The next few billing dates, so the screen can show what the customer will be charged and when.
    const upcoming: string[] = [];
    for (let i = 0; i < UPCOMING && sub.status === 'active'; i++) {
      const date = scheduleOf(sub, sub.cycle + i, sub.runCount + i);
      if (!date) break;
      upcoming.push(date);
    }
    return { ...sub, items, perRun: this.totals(items, discountOf(sub), sub.taxRateBps), upcoming };
  }

  create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateSubscriptionInput }) {
    return withTransaction(async (tx) => {
      const today = localDate(new Date(), await subscriptionsRepository.timezoneOf({ organizationId }));
      if (input.startOn < today) throw new BadRequestError('The start date cannot be in the past', 'START_IN_PAST');

      const customer = await this.resolveCustomer(tx, organizationId, input);
      const { lines, currency } = await this.resolveLines(tx, organizationId, input.items);
      this.totals(lines, input.discount ?? null, input.taxRateBps); // rejects a discount larger than the subtotal
      const draft = {
        startOn: input.startOn,
        unit: input.intervalUnit,
        every: input.intervalCount,
        cycle: 0,
        runCount: 0,
        endOn: input.endOn ?? null,
        maxRuns: input.maxRuns ?? null,
      };
      const next = nextRunOn(draft);
      if (!next) throw new BadRequestError('This schedule would never bill', 'EMPTY_SCHEDULE');

      const sub = await subscriptionsRepository.insert(
        {
          organizationId,
          name: input.name,
          ...customer,
          currency,
          discountType: input.discount?.type,
          discountValue: input.discount?.value,
          taxRateBps: input.taxRateBps,
          intervalUnit: input.intervalUnit,
          intervalCount: input.intervalCount,
          startOn: input.startOn,
          endOn: input.endOn,
          maxRuns: input.maxRuns,
          nextRunOn: next,
          dueDays: input.dueDays,
          autoSend: input.autoSend,
          notes: input.notes,
          createdBy: userId,
        },
        tx,
      );
      await subscriptionsRepository.insertItems(
        lines.map((l) => ({ ...l, organizationId, subscriptionId: sub.id })),
        tx,
      );
      return sub;
    });
  }

  // Terms of future invoices only; invoices already issued are never touched.
  update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateSubscriptionInput }) {
    return withTransaction(async (tx) => {
      const sub = await this.lock(tx, organizationId, id);
      if (sub.status !== 'active' && sub.status !== 'paused')
        throw new ConflictError(`A ${sub.status} subscription can no longer be edited`, 'SUBSCRIPTION_LOCKED');

      let currency = sub.currency;
      let lines: Line[] = await subscriptionsRepository.findItems({ subscriptionId: id }, tx);
      if (input.items) {
        ({ lines, currency } = await this.resolveLines(tx, organizationId, input.items));
        await subscriptionsRepository.deleteItems({ subscriptionId: id }, tx);
        await subscriptionsRepository.insertItems(
          lines.map((l) => ({ ...l, organizationId, subscriptionId: id })),
          tx,
        );
      }
      const discount = input.discount === undefined ? discountOf(sub) : input.discount;
      const taxRateBps = input.taxRateBps ?? sub.taxRateBps;
      this.totals(lines, discount, taxRateBps);

      const merged = { ...sub, endOn: input.endOn === undefined ? sub.endOn : input.endOn, maxRuns: input.maxRuns === undefined ? sub.maxRuns : input.maxRuns };
      const next = scheduleOf(merged);
      return subscriptionsRepository.update(
        {
          id,
          set: {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.dueDays !== undefined && { dueDays: input.dueDays }),
            ...(input.autoSend !== undefined && { autoSend: input.autoSend }),
            ...(input.notes !== undefined && { notes: input.notes }),
            currency,
            discountType: discount?.type ?? null,
            discountValue: discount?.value ?? null,
            taxRateBps,
            endOn: merged.endOn,
            maxRuns: merged.maxRuns,
            nextRunOn: next,
            // Cutting the end date or run limit below what has been billed finishes the subscription.
            ...(next === null && { status: 'completed' }),
          },
        },
        tx,
      );
    });
  }

  pause({ organizationId, id }: { organizationId: string; id: string }) {
    return this.transition(organizationId, id, ['active'], () => ({ status: 'paused' }), 'Only an active subscription can be paused');
  }

  // Continues from the next date that is not in the past: the paused time is never billed.
  resume({ organizationId, id }: { organizationId: string; id: string }) {
    return withTransaction(async (tx) => {
      const sub = await this.lock(tx, organizationId, id);
      if (sub.status !== 'paused') throw new ConflictError('Only a paused subscription can be resumed', 'SUBSCRIPTION_LOCKED');
      const today = localDate(new Date(), await subscriptionsRepository.timezoneOf({ organizationId }));
      const cycle = cycleFrom(sub.startOn, sub.intervalUnit as IntervalUnit, sub.intervalCount, sub.cycle, today);
      const next = scheduleOf(sub, cycle);
      return subscriptionsRepository.update(
        { id, set: { status: next ? 'active' : 'completed', cycle, nextRunOn: next, failureCount: 0, lastError: null, lastAttemptAt: null } },
        tx,
      );
    });
  }

  cancel({ organizationId, id }: { organizationId: string; id: string }) {
    return this.transition(organizationId, id, ['active', 'paused'], () => ({ status: 'cancelled', nextRunOn: null }), 'This subscription is already finished');
  }

  // A subscription that never billed can be removed; one with invoices is cancelled instead, so its history stays.
  remove({ organizationId, id }: { organizationId: string; id: string }) {
    return withTransaction(async (tx) => {
      const sub = await this.lock(tx, organizationId, id);
      if (sub.runCount > 0) throw new ConflictError('This subscription has invoices; cancel it instead', 'SUBSCRIPTION_HAS_INVOICES');
      await subscriptionsRepository.remove({ id }, tx);
    });
  }

  async runs({ organizationId, id, page, limit }: { organizationId: string; id: string; page: number; limit: number }) {
    await this.find(organizationId, id);
    return subscriptionsRepository.listRuns({ subscriptionId: id, page, limit });
  }

  // Bills the next billing date now, ahead of its day. Errors go straight back to the caller (nothing is recorded as a failure).
  async runNow({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }) {
    const result = await withTransaction((tx) => this.bill(tx, { organizationId, id, manual: true, actorFallback: userId }));
    if (!result) throw new NotFoundError('Subscription not found');
    await this.afterBilled(result);
    return result;
  }

  // The scheduler's pass: bills every subscription whose billing date has come in its organization's own timezone.
  async runDue(now = new Date()): Promise<{ invoiced: number; failed: number }> {
    const totals = { invoiced: 0, failed: 0 };
    for (const candidate of await subscriptionsRepository.dueCandidates({ limit: SCAN_BATCH })) {
      if (!candidate.nextRunOn || candidate.nextRunOn > localDate(now, candidate.timezone)) continue;
      try {
        const result = await withTransaction((tx) =>
          this.bill(tx, { organizationId: candidate.organizationId, id: candidate.id, manual: false, dueBy: localDate(now, candidate.timezone) }),
        );
        if (result) {
          totals.invoiced++;
          await this.afterBilled(result);
        }
      } catch (err) {
        totals.failed++;
        await this.recordFailure(candidate.organizationId, candidate.id, err);
      }
    }
    return totals;
  }

  // ---- billing ----

  // One billing date: order + invoice + run record + schedule advance, all in one transaction. The unique index on a billed date and the row
  // lock mean two instances (or a manual click racing the scheduler) cannot bill the same date twice.
  private async bill(
    tx: DbTransaction,
    { organizationId, id, manual, actorFallback, dueBy }: { organizationId: string; id: string; manual: boolean; actorFallback?: string; dueBy?: string },
  ) {
    const sub = await subscriptionsRepository.lockById({ organizationId, id, skipLocked: !manual }, tx);
    if (!sub) return null; // gone, or another instance is billing it right now
    if (sub.status !== 'active' || !sub.nextRunOn) {
      if (manual) throw new ConflictError('Only an active subscription can be billed', 'SUBSCRIPTION_NOT_ACTIVE');
      return null;
    }
    const scheduledFor = sub.nextRunOn;
    // The candidate list was read before the lock: another instance may have billed this date and moved the schedule on since.
    if (dueBy !== undefined && scheduledFor > dueBy) return null;
    const advance = () => {
      const cycle = sub.cycle + 1;
      const runCount = sub.runCount + 1;
      const next = scheduleOf(sub, cycle, runCount);
      return { cycle, runCount, nextRunOn: next, ...(next === null && { status: 'completed' }) };
    };
    if (await subscriptionsRepository.invoicedRunExists({ subscriptionId: id, scheduledFor }, tx)) {
      // Already billed (a previous attempt committed the run but not the schedule): just move on.
      await subscriptionsRepository.update({ id, set: advance() }, tx);
      return null;
    }

    const actor = (await runAsResolver(organizationId)(sub.createdBy)).willRunAs?.id ?? actorFallback;
    if (!actor) throw new Error('No active user to bill as');
    const items = await subscriptionsRepository.findItems({ subscriptionId: id }, tx);
    const order = await ordersService.createIn(tx, {
      organizationId,
      userId: actor,
      input: {
        contactId: sub.contactId,
        companyId: sub.companyId,
        items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        discount: discountOf(sub),
        taxRateBps: sub.taxRateBps,
        notes: `Subscription "${sub.name}" (${scheduledFor})`,
      },
      unitPrices: new Map(items.map((i) => [i.productId, i.unitPriceMinor])),
    });
    const timezone = await subscriptionsRepository.timezoneOf({ organizationId });
    const invoice = await invoicesService.createIn(tx, {
      organizationId,
      userId: actor,
      input: { orderId: order.id, dueDate: addDays(localDate(new Date(), timezone), sub.dueDays), notes: `Subscription "${sub.name}"` },
    });
    const run = await subscriptionsRepository.insertRun(
      { organizationId, subscriptionId: id, scheduledFor, status: 'invoiced', orderId: order.id, invoiceId: invoice.id },
      tx,
    );
    const updated = await subscriptionsRepository.update({ id, set: { ...advance(), failureCount: 0, lastError: null, lastAttemptAt: new Date() } }, tx);
    await audit(
      {
        organizationId,
        actorUserId: actor,
        action: 'subscription.billed',
        targetType: 'subscription',
        targetId: id,
        metadata: { scheduledFor, orderId: order.id, invoiceId: invoice.id },
      },
      tx,
    );
    return { subscription: updated, order, invoice, run, actor };
  }

  // After the commit: email the invoice if asked to, and tell webhooks and workflows. None of it can undo the billing.
  private async afterBilled({ subscription, order, invoice, run, actor }: NonNullable<Awaited<ReturnType<SubscriptionsService['bill']>>>) {
    const data = {
      id: subscription.id,
      name: subscription.name,
      scheduledFor: run.scheduledFor,
      orderId: order.id,
      invoiceId: invoice.id,
      totalMinor: invoice.totalMinor,
    };
    void enqueueWebhookEvent({ organizationId: subscription.organizationId, event: 'subscriptions.invoiced', data });
    void enqueueWorkflowEvent({
      organizationId: subscription.organizationId,
      actorId: actor,
      event: 'subscriptions.invoiced',
      id: subscription.id,
      values: {
        name: subscription.name,
        customerName: subscription.customerName,
        totalMinor: invoice.totalMinor,
        currency: invoice.currency,
        invoiceNumber: invoice.invoiceNumber,
      },
      changed: [],
      depth: 0,
    });
    if (subscription.autoSend && (await canSendMail(subscription.organizationId))) {
      try {
        await mailService.sendInvoice({ organizationId: subscription.organizationId, id: invoice.id });
      } catch (err) {
        logger.warn({ err, subscriptionId: subscription.id, invoiceId: invoice.id }, 'Subscription invoice was created but could not be emailed');
      }
    }
  }

  // A failed attempt is recorded outside the rolled-back billing transaction. The scheduler retries every few hours; after
  // MAX_FAILURES in a row the subscription pauses and its owner is told.
  private async recordFailure(organizationId: string, id: string, err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.warn({ subscriptionId: id, err: message }, 'Subscription billing failed');
    try {
      const paused = await withTransaction(async (tx) => {
        const sub = await subscriptionsRepository.lockById({ organizationId, id }, tx);
        if (!sub || sub.status !== 'active') return null;
        if (sub.nextRunOn)
          await subscriptionsRepository.insertRun({ organizationId, subscriptionId: id, scheduledFor: sub.nextRunOn, status: 'failed', error: message }, tx);
        const failureCount = sub.failureCount + 1;
        const pause = failureCount >= MAX_FAILURES;
        await subscriptionsRepository.update(
          { id, set: { failureCount, lastError: message, lastAttemptAt: new Date(), ...(pause && { status: 'paused' }) } },
          tx,
        );
        return pause ? sub : null;
      });
      if (paused) {
        await notifyWorkflowOwners({
          organizationId,
          createdBy: paused.createdBy,
          title: `Subscription "${paused.name}" was paused`,
          body: `Billing failed ${MAX_FAILURES} times in a row: ${message}`,
          dedupeKey: `subscription_paused:${id}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    } catch (failure) {
      logger.error({ err: failure, subscriptionId: id }, 'Could not record a subscription billing failure');
    }
  }

  // ---- helpers ----

  private async find(organizationId: string, id: string) {
    const sub = await subscriptionsRepository.findById({ organizationId, id });
    if (!sub) throw new NotFoundError('Subscription not found');
    return sub;
  }

  private async lock(tx: DbTransaction, organizationId: string, id: string) {
    const sub = await subscriptionsRepository.lockById({ organizationId, id }, tx);
    if (!sub) throw new NotFoundError('Subscription not found');
    return sub;
  }

  private transition(organizationId: string, id: string, from: string[], to: () => Partial<typeof subscriptions.$inferInsert>, message: string) {
    return withTransaction(async (tx) => {
      const sub = await this.lock(tx, organizationId, id);
      if (!from.includes(sub.status)) throw new ConflictError(message, 'SUBSCRIPTION_LOCKED');
      return subscriptionsRepository.update({ id, set: to() }, tx);
    });
  }

  private totals(lines: { unitPriceMinor: number; quantity: number }[], discount: Discount | null, taxRateBps: number) {
    try {
      return calculateTotals(lines, discount, taxRateBps);
    } catch {
      throw new BadRequestError('The discount is larger than the subtotal', 'DISCOUNT_TOO_LARGE');
    }
  }

  private async resolveCustomer(
    tx: DbTransaction,
    organizationId: string,
    input: { contactId?: string | null | undefined; companyId?: string | null | undefined },
  ) {
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

  private async resolveLines(tx: DbTransaction, organizationId: string, items: CreateSubscriptionInput['items']) {
    const found = await quotesRepository.findProducts({ organizationId, ids: items.map((i) => i.productId) }, tx);
    const byId = new Map(found.map((p) => [p.id, p]));
    const lines: Line[] = items.map((item) => {
      const product = byId.get(item.productId);
      if (!product) throw new BadRequestError('A product in this subscription does not exist', 'INVALID_PRODUCT');
      if (!product.isActive) throw new ConflictError(`"${product.name}" is not available`, 'PRODUCT_INACTIVE');
      return { productId: product.id, productName: product.name, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor ?? product.priceMinor };
    });
    const currencies = new Set(found.map((p) => p.currency));
    const [currency] = currencies;
    if (!currency) throw new BadRequestError('A subscription needs at least one item', 'INVALID_PRODUCT');
    if (currencies.size > 1) throw new BadRequestError('All products in a subscription must use the same currency', 'MIXED_CURRENCY');
    return { lines, currency };
  }
}

export const subscriptionsService = new SubscriptionsService();
