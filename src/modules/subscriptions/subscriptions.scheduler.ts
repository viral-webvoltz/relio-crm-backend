import { logger } from '@/shared/utils/logger.js';
import { subscriptionsService } from './subscriptions.service.js';

const TICK_MS = 5 * 60_000;

// Bills what has come due. Safe with several instances: billing locks the subscription row (skipping locked ones) and a unique index
// forbids billing the same date twice.
export function startSubscriptionScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await subscriptionsService.runDue();
    } catch (err) {
      logger.error({ err }, 'Subscription scheduler tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
