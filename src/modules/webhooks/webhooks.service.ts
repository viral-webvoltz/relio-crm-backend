import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { webhookDeliveries, webhookEndpoints } from '@/database/schema/webhooks.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { getOffset, type ListQuery } from '@/shared/pagination/index.js';
import type { CreateEndpointInput, UpdateEndpointInput } from './webhooks.validation.js';

const MAX_ENDPOINTS = 10;
const GRACE_MS = 24 * 60 * 60 * 1000;

// Everything except the secret, which is shown once at creation.
const publicColumns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  isActive: webhookEndpoints.isActive,
  createdBy: webhookEndpoints.createdBy,
  createdAt: webhookEndpoints.createdAt,
};

const scope = (organizationId: string, id: string) => and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id));

const deliveryScope = (organizationId: string, endpointId: string, id: string) =>
  and(eq(webhookDeliveries.organizationId, organizationId), eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.id, id));

class WebhooksService {
  list(organizationId: string) {
    return db.select(publicColumns).from(webhookEndpoints).where(eq(webhookEndpoints.organizationId, organizationId)).orderBy(desc(webhookEndpoints.createdAt));
  }

  async create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateEndpointInput }) {
    const [{ n = 0 } = {}] = await db.select({ n: count() }).from(webhookEndpoints).where(eq(webhookEndpoints.organizationId, organizationId));
    // ponytail: count-then-insert can overshoot the cap by a few under concurrent creates; lock the organization row if that matters.
    if (n >= MAX_ENDPOINTS) throw new ConflictError(`At most ${MAX_ENDPOINTS} webhook endpoints are allowed`, 'WEBHOOK_LIMIT');
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    const [row] = await db
      .insert(webhookEndpoints)
      .values({ organizationId, url: input.url, events: input.events, secret, createdBy: userId })
      .returning(publicColumns);
    return { ...row, secret };
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateEndpointInput }) {
    const [row] = await db.update(webhookEndpoints).set(input).where(scope(organizationId, id)).returning(publicColumns);
    if (!row) throw new NotFoundError('Webhook endpoint not found');
    return row;
  }

  async remove({ organizationId, id }: { organizationId: string; id: string }) {
    const deleted = await db.delete(webhookEndpoints).where(scope(organizationId, id)).returning({ id: webhookEndpoints.id });
    if (deleted.length === 0) throw new NotFoundError('Webhook endpoint not found');
  }

  async listDeliveries({ organizationId, id, query }: { organizationId: string; id: string; query: ListQuery }) {
    await this.assertExists(organizationId, id);
    const where = and(eq(webhookDeliveries.organizationId, organizationId), eq(webhookDeliveries.endpointId, id));
    const [rows, [totalRow]] = await Promise.all([
      db
        .select({
          id: webhookDeliveries.id,
          event: webhookDeliveries.event,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          responseStatus: webhookDeliveries.responseStatus,
          lastError: webhookDeliveries.lastError,
          nextAttemptAt: webhookDeliveries.nextAttemptAt,
          createdAt: webhookDeliveries.createdAt,
          deliveredAt: webhookDeliveries.deliveredAt,
        })
        .from(webhookDeliveries)
        .where(where)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(query.limit)
        .offset(getOffset(query)),
      db.select({ n: count() }).from(webhookDeliveries).where(where),
    ]);
    return { rows, total: totalRow?.n ?? 0 };
  }

  async getDelivery({ organizationId, id, deliveryId }: { organizationId: string; id: string; deliveryId: string }) {
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(deliveryScope(organizationId, id, deliveryId));
    if (!row) throw new NotFoundError('Delivery not found');
    return row;
  }

  // Failed deliveries only, unless forced (then delivered ones too). The status guard in the update keeps a delivery that is being sent from being reset.
  async retryDelivery({ organizationId, id, deliveryId, force }: { organizationId: string; id: string; deliveryId: string; force: boolean }) {
    const current = await this.getDelivery({ organizationId, id, deliveryId });
    if (current.status === 'sending') throw new ConflictError('The delivery is being sent right now', 'DELIVERY_SENDING');
    if (current.status !== 'failed' && !(force && current.status === 'delivered')) {
      throw new ConflictError(`Only failed deliveries can be retried (status is ${current.status})`, 'DELIVERY_NOT_RETRYABLE');
    }
    const [row] = await db
      .update(webhookDeliveries)
      .set({ status: 'queued', attempts: 0, nextAttemptAt: sql`now()` })
      .where(and(deliveryScope(organizationId, id, deliveryId), ne(webhookDeliveries.status, 'sending')))
      .returning();
    if (!row) throw new ConflictError('The delivery is being sent right now', 'DELIVERY_SENDING');
    return row;
  }

  // The old secret keeps signing for GRACE_MS (the dispatcher signs with both); rotating again replaces it.
  async rotateSecret({ organizationId, id }: { organizationId: string; id: string }) {
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    const [row] = await db
      .update(webhookEndpoints)
      .set({ previousSecret: webhookEndpoints.secret, previousSecretExpiresAt: new Date(Date.now() + GRACE_MS), secret })
      .where(scope(organizationId, id))
      .returning({ ...publicColumns, previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt });
    if (!row) throw new NotFoundError('Webhook endpoint not found');
    return { ...row, secret };
  }

  // Goes to this endpoint only, whatever it is subscribed to.
  async sendTest({ organizationId, id }: { organizationId: string; id: string }) {
    await this.assertExists(organizationId, id);
    await db.insert(webhookDeliveries).values({ organizationId, endpointId: id, event: 'webhook.test', payload: { message: 'This is a test event' } });
  }

  private async assertExists(organizationId: string, id: string) {
    const [row] = await db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(scope(organizationId, id));
    if (!row) throw new NotFoundError('Webhook endpoint not found');
  }
}

export const webhooksService = new WebhooksService();
