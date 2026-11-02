import { logger } from '@/shared/utils/logger.js';
import { privacyService } from './privacy.service.js';

const EVERY_MS = 6 * 60 * 60_000;
const FIRST_AFTER_MS = 2 * 60_000;

// Applies each organization's log-retention limits. Deleting the same old rows twice is harmless, so several instances need no coordination.
export function startRetentionPurger(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const purged = await privacyService.purgeExpired();
      if (purged.auditLogs || purged.emailLogs || purged.notifications) logger.info(purged, 'retention purge');
    } catch (err) {
      logger.error({ err }, 'Retention purge failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), FIRST_AFTER_MS);
  const timer = setInterval(() => void run(), EVERY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
