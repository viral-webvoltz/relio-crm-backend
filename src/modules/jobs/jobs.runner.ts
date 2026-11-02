import { AppError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/logger.js';
import { runExportJob } from '@/modules/exports/exports.service.js';
import { runImportJob } from '@/modules/imports/imports.service.js';
import { jobsRepository } from './jobs.repository.js';
import type { JobKind, JobRow } from './jobs.repository.js';

const POLL_INTERVAL_MS = 3_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface HandlerOutput {
  result?: unknown;
  fileName?: string;
  fileContent?: string;
  payload?: Record<string, unknown>;
}
type JobHandler = (job: JobRow, setProgress: (value: number) => Promise<void>) => Promise<HandlerOutput>;

const handlers: Record<JobKind, JobHandler> = { export: runExportJob, import: runImportJob };

const isJobKind = (kind: string): kind is JobKind => kind === 'export' || kind === 'import';

async function runJob(job: JobRow) {
  try {
    if (!isJobKind(job.kind)) throw new Error(`Unknown job kind "${job.kind}"`);
    const output = await handlers[job.kind](job, (value) => jobsRepository.setProgress(job.id, value));
    await jobsRepository.markDone(job.id, output);
  } catch (err) {
    logger.error({ err, jobId: job.id, kind: job.kind }, 'job failed');
    // Only our own errors carry a message that is safe to show to the user.
    const message = err instanceof AppError ? err.message : 'The job failed unexpectedly';
    await jobsRepository.markFailed(job.id, message).catch((markErr: unknown) => logger.error({ err: markErr, jobId: job.id }, 'could not mark job failed'));
  }
}

// In-process runner: polls for queued jobs, one at a time. Returns a function that stops it.
export function startJobRunner() {
  let stopped = false;
  let busy = false;
  let lastCleanup = 0;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        lastCleanup = Date.now();
        await jobsRepository.deleteExpired();
      }
      for (let job = await jobsRepository.claimNext(); job && !stopped; job = await jobsRepository.claimNext()) await runJob(job);
    } catch (err) {
      logger.error({ err }, 'job runner tick failed');
    } finally {
      busy = false;
    }
  };

  jobsRepository
    .failStale()
    .then((count) => count > 0 && logger.warn({ count }, 'marked interrupted jobs as failed'))
    .catch((err: unknown) => logger.error({ err }, 'could not recover stale jobs'));

  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
