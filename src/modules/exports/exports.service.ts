import { createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { Response } from 'express';
import { z } from 'zod';
import { appConfig } from '@/config/app.config.js';
import { env } from '@/config/env.js';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { CSV_BOM, csvLine } from '@/modules/jobs/csv.js';
import { jobsRepository } from '@/modules/jobs/jobs.repository.js';
import type { JobRow } from '@/modules/jobs/jobs.repository.js';
import { exportResourceNames, exportResources } from './exports.registry.js';
import type { ExportResourceName } from './exports.registry.js';

export const SYNC_EXPORT_MAX_ROWS = 5_000;
const JOB_EXPORT_MAX_ROWS = 100_000;
const JOB_EXPORT_MAX_BYTES = 25 * 1024 * 1024; // the CSV is stored in the jobs table
const DOWNLOAD_LINK_TTL_MS = 15 * 60 * 1000;

type Scope = { organizationId: string; userId: string };

const exportPayloadSchema = z.object({ resource: z.enum(exportResourceNames), query: z.record(z.string(), z.unknown()) });

const fileName = (resource: string) => `${resource}-${new Date().toISOString().slice(0, 10)}.csv`;

const signature = (jobId: string, userId: string, expires: number) =>
  createHmac('sha256', env.JWT_SECRET).update(`export-download:${jobId}:${userId}:${expires}`).digest();

const signatureMatches = (jobId: string, userId: string, expires: number, sig: string) => {
  const given = Buffer.from(sig, 'hex');
  const expected = signature(jobId, userId, expires);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const signedDownloadUrl = (jobId: string, userId: string) => {
  const expires = Date.now() + DOWNLOAD_LINK_TTL_MS;
  return `${appConfig.apiPrefix}/exports/${jobId}/download?expires=${expires}&sig=${signature(jobId, userId, expires).toString('hex')}`;
};

// Waits for the socket to drain; returns false when the client went away.
async function write(res: Response, chunk: string) {
  if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
  return !res.destroyed;
}

class ExportsService {
  assertCanExport(permissions: readonly string[], resource: ExportResourceName) {
    if (!permissions.includes(exportResources[resource].permission)) throw new ForbiddenError();
  }

  // Small exports are streamed page by page straight to the response; the first page decides 413 before any byte is sent.
  async streamCsv({ organizationId, userId, resource, query, res }: Scope & { resource: ExportResourceName; query: unknown; res: Response }) {
    const config = exportResources[resource];
    const parsed = config.parseQuery(query);
    const first = await config.fetchPage({ organizationId, userId, query: parsed, page: 1 });
    if (first.total > SYNC_EXPORT_MAX_ROWS) {
      throw new AppError(
        `This export has ${first.total} rows; up to ${SYNC_EXPORT_MAX_ROWS} can be downloaded directly. Use POST /exports for larger sets.`,
        413,
        'EXPORT_TOO_LARGE',
      );
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(resource)}"`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!(await write(res, CSV_BOM + csvLine(config.headers)))) return;
      let sent = 0;
      let page = first;
      for (let n = 1; ; n++) {
        if (page.rows.length === 0) break;
        if (!(await write(res, page.rows.map((row) => csvLine(row)).join('')))) return;
        sent += page.rows.length;
        if (sent >= first.total) break;
        page = await config.fetchPage({ organizationId, userId, query: parsed, page: n + 1 });
      }
      res.end();
    } catch (err) {
      // Headers are already out, so the error handler can no longer send a JSON body: abort the stream.
      res.destroy(err instanceof Error ? err : undefined);
    }
  }

  async createJob({ organizationId, userId, resource, query }: Scope & { resource: ExportResourceName; query: unknown }) {
    const parsed = exportResources[resource].parseQuery(query);
    return jobsRepository.create({ organizationId, userId, kind: 'export', payload: { resource, query: parsed } });
  }

  async getJob({ organizationId, userId, id }: Scope & { id: string }) {
    const job = await jobsRepository.findSummary({ organizationId, userId, id, kind: 'export' });
    if (!job) throw new NotFoundError('Export not found');
    const ready = job.status === 'done' && job.hasFile && job.expiresAt > new Date();
    return {
      status: job.status,
      progress: job.progress,
      error: job.error,
      downloadUrl: ready ? signedDownloadUrl(id, userId) : null,
    };
  }

  async getDownload({ organizationId, userId, id, expires, sig }: Scope & { id: string; expires: number; sig: string }) {
    const file = await jobsRepository.findFile({ organizationId, userId, id, kind: 'export' });
    if (!file) throw new NotFoundError('Export not found');
    if (!signatureMatches(id, userId, expires, sig)) throw new ForbiddenError('Invalid download link', 'INVALID_DOWNLOAD_LINK');
    if (expires < Date.now()) throw new ForbiddenError('Download link has expired', 'DOWNLOAD_LINK_EXPIRED');
    if (file.status !== 'done' || file.fileContent === null || file.expiresAt < new Date()) throw new NotFoundError('Export file is not available');
    return { fileName: file.fileName ?? 'export.csv', content: file.fileContent };
  }
}

export const exportsService = new ExportsService();

// Job handler: pages through the same list method with the stored (already validated) query.
export async function runExportJob(job: JobRow, setProgress: (value: number) => Promise<void>) {
  const { resource, query } = exportPayloadSchema.parse(job.payload);
  const config = exportResources[resource];
  const scope = { organizationId: job.organizationId, userId: job.userId };

  const chunks = [CSV_BOM + csvLine(config.headers)];
  let bytes = chunks[0]?.length ?? 0;
  let fetched = 0;
  for (let page = 1; ; page++) {
    const { rows, total } = await config.fetchPage({ ...scope, query, page });
    if (total > JOB_EXPORT_MAX_ROWS)
      throw new BadRequestError(`This export has ${total} rows; the limit is ${JOB_EXPORT_MAX_ROWS}. Narrow the filters.`, 'EXPORT_TOO_LARGE');
    if (rows.length === 0) break;
    const chunk = rows.map((row) => csvLine(row)).join('');
    bytes += chunk.length;
    if (bytes > JOB_EXPORT_MAX_BYTES) throw new BadRequestError('The export file is too large. Narrow the filters.', 'EXPORT_TOO_LARGE');
    chunks.push(chunk);
    fetched += rows.length;
    await setProgress(Math.min(99, Math.floor((fetched / Math.max(total, 1)) * 100)));
    if (fetched >= total) break;
  }
  return { result: { rows: fetched }, fileName: fileName(resource), fileContent: chunks.join('') };
}
