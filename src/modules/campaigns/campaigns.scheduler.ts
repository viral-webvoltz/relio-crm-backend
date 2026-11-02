import { logger } from '@/shared/utils/logger.js';
import { campaignsRepository } from './campaigns.repository.js';
import { campaignsService } from './campaigns.service.js';

const TICK_MS = 60_000;
const BATCH = 5;

// Launches campaigns whose scheduled time has come. launch() locks the campaign row and re-checks its status, so with several
// instances running exactly one of them sends it.
export function startCampaignScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const due of await campaignsRepository.dueScheduled({ now: new Date(), limit: BATCH })) await campaignsService.launchScheduled(due);
    } catch (err) {
      logger.error({ err }, 'Campaign scheduler tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
