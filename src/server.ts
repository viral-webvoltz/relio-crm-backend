import { createApp } from './app.js';
import { env } from '@/config/env.js';
import { db, pool } from '@/config/database.js';
import { lt } from 'drizzle-orm';
import { customerSessions, sessions } from '@/database/schema/index.js';
import { purgeExpiredIdempotencyKeys } from '@/middleware/idempotency.js';
import { startMailer } from '@/modules/mail/mail.sender.js';
import { startGmailInboxSync } from '@/modules/mail/gmail.inbox.js';
import { startWebhookDispatcher } from '@/modules/webhooks/webhooks.dispatcher.js';
import { startWorkflowWorker } from '@/modules/workflows/workflows.worker.js';
import { startReportScheduler } from '@/modules/reports/reports.scheduler.js';
import { startRetentionPurger } from '@/modules/privacy/privacy.scheduler.js';
import { startSubscriptionScheduler } from '@/modules/subscriptions/subscriptions.scheduler.js';
import { startSlaScheduler } from '@/modules/support/sla.scheduler.js';
import { startCampaignScheduler } from '@/modules/campaigns/campaigns.scheduler.js';
import { startTrashPurger } from '@/modules/trash-purge/index.js';
import { startJobRunner } from '@/modules/jobs/jobs.runner.js';
import { startNotificationScheduler } from '@/modules/notifications/notifications.scheduler.js';
import { logger } from '@/shared/utils/logger.js';

const shutdownTimeoutMs = 10_000;

const server = createApp().listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));

// Keys past their 24h window are already ignored on lookup; this just keeps the table small.
const purgeTimer = setInterval(() => purgeExpiredIdempotencyKeys().catch((err: unknown) => logger.error({ err }, 'idempotency purge failed')), 60 * 60 * 1000);
purgeTimer.unref();

// Expired sessions are already rejected on lookup; this keeps the tables small.
const purgeSessions = async () => {
  const now = new Date();
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.delete(customerSessions).where(lt(customerSessions.expiresAt, now));
};
const sessionTimer = setInterval(() => purgeSessions().catch((err: unknown) => logger.error({ err }, 'session purge failed')), 60 * 60 * 1000);
sessionTimer.unref();

// A stray rejection must not take the whole API down silently; log it and let the process manager decide.
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

const stopJobRunner = startJobRunner();
const stopNotificationScheduler = startNotificationScheduler();
const stopMailer = startMailer();
const stopGmailInboxSync = startGmailInboxSync();
const stopWebhookDispatcher = startWebhookDispatcher();
const stopReportScheduler = startReportScheduler();
const stopTrashPurger = startTrashPurger();
const stopWorkflowWorker = startWorkflowWorker();
const stopCampaignScheduler = startCampaignScheduler();
const stopSlaScheduler = startSlaScheduler();
const stopSubscriptionScheduler = startSubscriptionScheduler();
const stopRetentionPurger = startRetentionPurger();

let isShuttingDown = false;
async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, shutdownTimeoutMs);
  forceExit.unref();

  stopJobRunner();
  stopNotificationScheduler();
  stopMailer();
  stopGmailInboxSync();
  stopWebhookDispatcher();
  stopReportScheduler();
  stopTrashPurger();
  stopCampaignScheduler();
  stopSlaScheduler();
  stopSubscriptionScheduler();
  stopRetentionPurger();
  await stopWorkflowWorker(); // lets the pass in flight finish; the shutdown timeout above still caps the wait

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeIdleConnections();
    });
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(signal));
