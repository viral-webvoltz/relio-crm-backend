import { and, count, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { jobs } from '@/database/schema/jobs.js';
import { TooManyRequestsError } from '@/shared/errors/index.js';

export type JobKind = 'export' | 'import';
export type JobRow = typeof jobs.$inferSelect;

const fileTtlMs = 24 * 60 * 60 * 1000;
const staleRunningMs = 10 * 60 * 1000;
const MAX_ACTIVE_JOBS_PER_USER = 3;

// Lightweight view for status endpoints: never loads the payload (an import's whole CSV) or the stored file.
const summary = {
  id: jobs.id,
  kind: jobs.kind,
  status: jobs.status,
  progress: jobs.progress,
  result: jobs.result,
  error: jobs.error,
  fileName: jobs.fileName,
  hasFile: sql<boolean>`${jobs.fileContent} is not null`,
  createdAt: jobs.createdAt,
  finishedAt: jobs.finishedAt,
  expiresAt: jobs.expiresAt,
};

const owned = ({ organizationId, userId, id, kind }: { organizationId: string; userId: string; id: string; kind: JobKind }) =>
  and(eq(jobs.organizationId, organizationId), eq(jobs.userId, userId), eq(jobs.id, id), eq(jobs.kind, kind));

class JobsRepository {
  async create({ organizationId, userId, kind, payload }: { organizationId: string; userId: string; kind: JobKind; payload: Record<string, unknown> }) {
    // ponytail: count-then-insert can overshoot by a few under concurrent requests; fine for an abuse cap.
    const [active] = await db
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), inArray(jobs.status, ['queued', 'running'])));
    if ((active?.n ?? 0) >= MAX_ACTIVE_JOBS_PER_USER) {
      throw new TooManyRequestsError('You already have several imports or exports in progress; wait for them to finish', 'TOO_MANY_JOBS');
    }
    const [row] = await db
      .insert(jobs)
      .values({ organizationId, userId, kind, payload, expiresAt: new Date(Date.now() + fileTtlMs) })
      .returning({ id: jobs.id });
    return row!;
  }

  async findSummary(scope: { organizationId: string; userId: string; id: string; kind: JobKind }) {
    const [row] = await db.select(summary).from(jobs).where(owned(scope));
    return row ?? null;
  }

  async findFile(scope: { organizationId: string; userId: string; id: string; kind: JobKind }) {
    const [row] = await db
      .select({ status: jobs.status, fileName: jobs.fileName, fileContent: jobs.fileContent, expiresAt: jobs.expiresAt })
      .from(jobs)
      .where(owned(scope));
    return row ?? null;
  }

  // One queued job per call; SKIP LOCKED keeps several runners (or processes) from claiming the same row.
  async claimNext() {
    const [row] = await db
      .update(jobs)
      .set({ status: 'running', startedAt: new Date(), progress: 0 })
      .where(eq(jobs.id, sql`(select id from jobs where status = 'queued' order by created_at limit 1 for update skip locked)`))
      .returning();
    return row ?? null;
  }

  async setProgress(id: string, progress: number) {
    await db.update(jobs).set({ progress }).where(eq(jobs.id, id));
  }

  async markDone(
    id: string,
    { result, fileName, fileContent, payload }: { result?: unknown; fileName?: string; fileContent?: string; payload?: Record<string, unknown> },
  ) {
    await db
      .update(jobs)
      .set({
        status: 'done',
        progress: 100,
        result: result ?? null,
        fileName: fileName ?? null,
        fileContent: fileContent ?? null,
        ...(payload && { payload }),
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + fileTtlMs),
      })
      .where(eq(jobs.id, id));
  }

  async markFailed(id: string, error: string) {
    await db
      .update(jobs)
      .set({ status: 'failed', error, finishedAt: new Date(), expiresAt: new Date(Date.now() + fileTtlMs) })
      .where(eq(jobs.id, id));
  }

  // Jobs left in `running` by a crashed process.
  async failStale() {
    const rows = await db
      .update(jobs)
      .set({ status: 'failed', error: 'Job was interrupted', finishedAt: new Date() })
      .where(and(eq(jobs.status, 'running'), lt(jobs.startedAt, new Date(Date.now() - staleRunningMs))))
      .returning({ id: jobs.id });
    return rows.length;
  }

  async deleteExpired() {
    await db.delete(jobs).where(and(lt(jobs.expiresAt, new Date()), sql`${jobs.status} in ('done', 'failed')`));
  }
}

export const jobsRepository = new JobsRepository();
