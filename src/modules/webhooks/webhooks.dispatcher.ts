import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { webhookDeliveries, webhookEndpoints } from '@/database/schema/webhooks.js';
import { logger } from '@/shared/utils/logger.js';
import { signatureHeader } from './webhooks.signature.js';
import { sendRequest } from './webhooks.http.js';

const POLL_MS = 5_000;
const BATCH = 10;
const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 10_000;
const LEASE_SECONDS = 120; // a delivery stuck in 'sending' (crashed process) becomes due again after this
const RETENTION_DAYS = 14;
const PURGE_MS = 60 * 60_000;
const backoffMs = (attempts: number) => 2 ** attempts * 15_000;

// Never throws: a webhook problem must not fail the request that produced the event.
export async function enqueueWebhookEvent({ organizationId, event, data }: { organizationId: string; event: string; data: unknown }): Promise<void> {
  try {
    await db.execute(sql`
      insert into webhook_deliveries (organization_id, endpoint_id, event, payload)
      select organization_id, id, ${event}::text, ${JSON.stringify(data ?? null)}::jsonb
      from webhook_endpoints
      where organization_id = ${organizationId} and is_active and (${event}::text = any(events) or '*' = any(events))`);
  } catch (err) {
    logger.error({ err, event }, 'Failed to enqueue webhook event');
  }
}

function claim() {
  const due = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.status, ['queued', 'sending']), lte(webhookDeliveries.nextAttemptAt, sql`now()`)))
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(1)
    .for('update', { skipLocked: true });
  return db
    .update(webhookDeliveries)
    .set({ status: 'sending', attempts: sql`${webhookDeliveries.attempts} + 1`, nextAttemptAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'` })
    .where(eq(webhookDeliveries.id, sql`(${due})`))
    .returning();
}

type Delivery = Awaited<ReturnType<typeof claim>>[number];

// Returns the HTTP status code; throws on network errors, timeouts and blocked destinations. The address is validated at connection time.
function post(delivery: Delivery, endpoint: { url: string; secrets: string[] }) {
  const body = JSON.stringify({ id: delivery.id, event: delivery.event, createdAt: delivery.createdAt.toISOString(), data: delivery.payload });
  const t = Math.floor(Date.now() / 1000);
  return sendRequest({
    url: endpoint.url,
    method: 'POST',
    body,
    timeoutMs: TIMEOUT_MS,
    headers: {
      'x-webhook-signature': signatureHeader(endpoint.secrets, t, body),
      'x-webhook-event': delivery.event,
      'x-webhook-delivery': delivery.id,
    },
  });
}

async function deliver(delivery: Delivery) {
  const [endpoint] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, delivery.endpointId));
  if (!endpoint?.isActive) {
    await db.update(webhookDeliveries).set({ status: 'failed', lastError: 'Endpoint missing or disabled' }).where(eq(webhookDeliveries.id, delivery.id));
    return;
  }
  // During a rotation's grace period sign with both secrets; an expired old secret is cleared lazily.
  const graceActive = endpoint.previousSecret !== null && endpoint.previousSecretExpiresAt !== null && endpoint.previousSecretExpiresAt > new Date();
  if (endpoint.previousSecret !== null && !graceActive) {
    await db.update(webhookEndpoints).set({ previousSecret: null, previousSecretExpiresAt: null }).where(eq(webhookEndpoints.id, endpoint.id));
  }
  const secrets = graceActive && endpoint.previousSecret !== null ? [endpoint.secret, endpoint.previousSecret] : [endpoint.secret];
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    responseStatus = await post(delivery, { url: endpoint.url, secrets });
    if (responseStatus < 200 || responseStatus >= 300) error = `Endpoint responded with ${responseStatus}`;
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
  if (!error) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'delivered', responseStatus, lastError: null, deliveredAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
    return;
  }
  const failed = delivery.attempts >= MAX_ATTEMPTS;
  logger.warn(
    { deliveryId: delivery.id, attempts: delivery.attempts, err: error },
    failed ? 'Webhook delivery failed permanently' : 'Webhook delivery failed, will retry',
  );
  await db
    .update(webhookDeliveries)
    .set({ status: failed ? 'failed' : 'queued', responseStatus, lastError: error, nextAttemptAt: new Date(Date.now() + backoffMs(delivery.attempts)) })
    .where(eq(webhookDeliveries.id, delivery.id));
}

export function startWebhookDispatcher(): () => void {
  let running = false;
  let lastPurge = 0;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (Date.now() - lastPurge > PURGE_MS) {
        lastPurge = Date.now();
        await db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, sql`now() - ${RETENTION_DAYS} * interval '1 day'`));
      }
      for (let i = 0; i < BATCH; i++) {
        const [delivery] = await claim();
        if (!delivery) break;
        try {
          await deliver(delivery);
        } catch (err) {
          logger.error({ err, deliveryId: delivery.id }, 'Webhook delivery bookkeeping failed'); // lease expiry retries it
        }
      }
    } catch (err) {
      logger.error({ err }, 'Webhook dispatcher tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
