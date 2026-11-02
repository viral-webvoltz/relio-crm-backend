import { z, ZodError } from 'zod';
import { AppError, BadRequestError, NotFoundError } from '@/shared/errors/index.js';
import { CsvParseError, CsvTooManyRowsError, csvLine, parseCsv } from '@/modules/jobs/csv.js';
import { jobsRepository } from '@/modules/jobs/jobs.repository.js';
import type { JobRow } from '@/modules/jobs/jobs.repository.js';
import { importResourceNames, importResources } from './imports.registry.js';
import type { ImportContext, ImportResourceName } from './imports.registry.js';

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;
const SAMPLE_ROWS = 5;
const MAX_REPORTED_INVALID = 500;
const PROGRESS_EVERY = 20;

const mappingSchema = z.record(z.string(), z.string());
const importPayloadSchema = z.object({
  resource: z.enum(importResourceNames),
  csv: z.string(),
  mapping: mappingSchema,
  canAssign: z.boolean(),
});

interface ParsedCsv {
  text: string;
  headers: string[];
  rows: string[][];
}

type Scope = { organizationId: string; userId: string };

const normalize = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

// Decodes and parses an uploaded body; enforces UTF-8, no NUL bytes, the row limit and a sane header row.
function readCsv(body: unknown): ParsedCsv {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new BadRequestError('Send the CSV file as the raw request body with Content-Type: text/csv', 'EMPTY_OR_INVALID_UPLOAD');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new BadRequestError('The file must be UTF-8 encoded', 'INVALID_CSV');
  }
  if (text.includes('\0')) throw new BadRequestError('The file contains NUL bytes', 'INVALID_CSV');

  let records: string[][];
  try {
    records = parseCsv(text, { maxRows: IMPORT_MAX_ROWS + 1 }); // header + data rows
  } catch (err) {
    if (err instanceof CsvTooManyRowsError) throw new AppError(`A file can have at most ${IMPORT_MAX_ROWS} data rows`, 413, 'IMPORT_TOO_MANY_ROWS');
    if (err instanceof CsvParseError) throw new BadRequestError(err.message, 'INVALID_CSV');
    throw err;
  }
  const [rawHeaders, ...rawRows] = records;
  const headers = rawHeaders?.map((h) => h.trim());
  if (!headers || headers.every((h) => h === '')) throw new BadRequestError('The file has no header row', 'INVALID_CSV');
  if (headers.some((h) => h === '')) throw new BadRequestError('Every column needs a header', 'INVALID_CSV');
  if (new Set(headers.map(normalize)).size !== headers.length) throw new BadRequestError('Column headers must be unique', 'INVALID_CSV');
  return { text, headers, rows: rawRows.map((row) => row.map((cell) => cell.trim())) };
}

// Mapping is { "<target field>": "<CSV column header>" }. Without one, columns whose header matches a field name are used.
function resolveMapping(resource: ImportResourceName, headers: string[], raw: string | undefined) {
  const { fields } = importResources[resource];
  let mapping: Record<string, string>;
  if (raw === undefined || raw.trim() === '') {
    mapping = {};
    for (const field of fields) {
      const header = headers.find((h) => normalize(h) === normalize(field));
      if (header) mapping[field] = header;
    }
  } else {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new BadRequestError('X-Import-Mapping must be valid JSON', 'INVALID_MAPPING');
    }
    const parsed = mappingSchema.safeParse(json);
    if (!parsed.success) throw new BadRequestError('X-Import-Mapping must be an object of { field: columnHeader }', 'INVALID_MAPPING');
    mapping = parsed.data;
    for (const [field, header] of Object.entries(mapping)) {
      if (!fields.includes(field)) throw new BadRequestError(`Unknown field "${field}"`, 'INVALID_MAPPING');
      if (!headers.includes(header)) throw new BadRequestError(`Column "${header}" is not in the file`, 'INVALID_MAPPING');
    }
  }
  if (Object.keys(mapping).length === 0) throw new BadRequestError('No columns are mapped to fields', 'INVALID_MAPPING');
  return mapping;
}

function rowRecord(resource: ImportResourceName, headers: string[], mapping: Record<string, string>, cells: string[]) {
  const byHeader = new Map(headers.map((h, i) => [h, cells[i] ?? ''] as const));
  const values: Record<string, string> = {};
  for (const [field, header] of Object.entries(mapping)) values[field] = byHeader.get(header) ?? '';
  return importResources[resource].toRecord(values);
}

const extraColumns = (headers: string[], cells: string[]) => cells.length > headers.length && cells.slice(headers.length).some((c) => c !== '');

function isUniqueViolation(err: unknown) {
  if (typeof err !== 'object' || err === null || !('cause' in err)) return false;
  const { cause } = err;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}

function describeError(err: unknown): string[] {
  if (err instanceof ZodError) return err.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
  if (err instanceof AppError) return [err.message];
  if (isUniqueViolation(err)) return ['A record with these details already exists'];
  return ['Unexpected error while saving this row'];
}

class ImportsService {
  preview(resource: ImportResourceName, body: unknown) {
    const { headers, rows } = readCsv(body);
    return {
      columns: headers,
      sampleRows: rows.slice(0, SAMPLE_ROWS),
      totalRows: rows.length,
      fields: importResources[resource].fields,
      suggestedMapping: resolveMapping(resource, headers, undefined),
    };
  }

  // Row numbers are spreadsheet rows: the header is row 1, the first record row 2.
  validate(resource: ImportResourceName, body: unknown, rawMapping: string | undefined) {
    const { headers, rows } = readCsv(body);
    const mapping = resolveMapping(resource, headers, rawMapping);
    const invalid: { row: number; errors: string[] }[] = [];
    let invalidCount = 0;
    rows.forEach((cells, index) => {
      let errors: string[] = [];
      if (extraColumns(headers, cells)) errors = ['Row has more columns than the header'];
      else {
        const result = importResources[resource].validate(rowRecord(resource, headers, mapping, cells));
        if (!result.success) errors = describeError(result.error);
      }
      if (errors.length === 0) return;
      invalidCount++;
      if (invalid.length < MAX_REPORTED_INVALID) invalid.push({ row: index + 2, errors });
    });
    return { valid: rows.length - invalidCount, invalidCount, invalid, truncated: invalidCount > invalid.length };
  }

  async commit(
    resource: ImportResourceName,
    body: unknown,
    rawMapping: string | undefined,
    { organizationId, userId, permissions }: Scope & { permissions: readonly string[] },
  ) {
    const { text, headers, rows } = readCsv(body);
    if (rows.length === 0) throw new BadRequestError('The file has no data rows', 'INVALID_CSV');
    const mapping = resolveMapping(resource, headers, rawMapping);
    const job = await jobsRepository.create({
      organizationId,
      userId,
      kind: 'import',
      payload: { resource, csv: text, mapping, canAssign: permissions.includes(`${resource}.assign`) },
    });
    return job;
  }

  async getJob({ organizationId, userId, id }: Scope & { id: string }) {
    const job = await jobsRepository.findSummary({ organizationId, userId, id, kind: 'import' });
    if (!job) throw new NotFoundError('Import not found');
    const counts = z.object({ total: z.number(), created: z.number(), failed: z.number() }).safeParse(job.result);
    return {
      status: job.status,
      progress: job.progress,
      total: counts.success ? counts.data.total : null,
      created: counts.success ? counts.data.created : null,
      failed: counts.success ? counts.data.failed : null,
      error: job.error,
      hasErrorFile: job.hasFile,
    };
  }

  async getErrorsCsv({ organizationId, userId, id }: Scope & { id: string }) {
    const file = await jobsRepository.findFile({ organizationId, userId, id, kind: 'import' });
    if (!file) throw new NotFoundError('Import not found');
    if (file.status !== 'done' && file.status !== 'failed') throw new NotFoundError('Import has not finished', 'IMPORT_NOT_FINISHED');
    if (file.fileContent === null || file.expiresAt < new Date()) throw new NotFoundError('This import has no failed rows', 'NO_IMPORT_ERRORS');
    return { fileName: file.fileName ?? 'import-errors.csv', content: file.fileContent };
  }
}

export const importsService = new ImportsService();

// Job handler: creates rows one by one through the resource service, so business rules and tenant scoping apply to each.
export async function runImportJob(job: JobRow, setProgress: (value: number) => Promise<void>) {
  const { resource, csv, mapping, canAssign } = importPayloadSchema.parse(job.payload);
  const [rawHeaders, ...rows] = parseCsv(csv);
  const headers = (rawHeaders ?? []).map((h) => h.trim());
  const context: ImportContext = { organizationId: job.organizationId, userId: job.userId, canAssign };

  const failedLines: string[] = [];
  let created = 0;
  for (const [index, rawCells] of rows.entries()) {
    const cells = rawCells.map((c) => c.trim());
    try {
      if (extraColumns(headers, cells)) throw new BadRequestError('Row has more columns than the header');
      await importResources[resource].create(context, rowRecord(resource, headers, mapping, cells));
      created++;
    } catch (err) {
      failedLines.push(csvLine([...headers.map((_, i) => cells[i] ?? ''), describeError(err).join('; ')]));
    }
    if ((index + 1) % PROGRESS_EVERY === 0) await setProgress(Math.min(99, Math.floor(((index + 1) / rows.length) * 100)));
  }

  return {
    result: { resource, total: rows.length, created, failed: failedLines.length },
    ...(failedLines.length > 0 && {
      fileName: `${resource}-import-errors.csv`,
      fileContent: csvLine([...headers, 'error']) + failedLines.join(''),
    }),
    payload: { resource }, // the uploaded CSV is no longer needed
  };
}
