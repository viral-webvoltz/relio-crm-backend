import express, { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { AppError, BadRequestError } from '@/shared/errors/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { importResourceNames, importResources } from './imports.registry.js';
import type { ImportResourceName } from './imports.registry.js';
import { IMPORT_MAX_BYTES, importsService } from './imports.service.js';

const jobParamsSchema = z.object({ jobId: z.uuid() });
type JobParams = z.infer<typeof jobParamsSchema>;

const rawCsv = express.raw({ type: ['text/csv', 'application/csv', 'text/plain'], limit: IMPORT_MAX_BYTES });

// Reads the raw body with a streaming size limit. body-parser errors are turned into AppErrors, because the central
// error handler would otherwise answer 500 for them. Any other content type leaves req.body unset -> 415.
const uploadCsv: RequestHandler = (req, res, next) => {
  rawCsv(req, res, (err?: unknown) => {
    if (err === undefined) {
      if (!Buffer.isBuffer(req.body)) return next(new AppError('Send the file as text/csv (or application/csv, text/plain)', 415, 'UNSUPPORTED_MEDIA_TYPE'));
      return next();
    }
    const type = typeof err === 'object' && err !== null && 'type' in err ? err.type : undefined;
    if (type === 'entity.too.large') return next(new AppError(`The file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`, 413, 'IMPORT_TOO_LARGE'));
    return next(new BadRequestError('Could not read the uploaded file', 'INVALID_UPLOAD'));
  });
};

const mappingHeader = (req: { header(name: string): string | undefined }) => req.header('x-import-mapping');

// Mounted at the API root, so authenticate is applied per route (a router-level one would also gate /auth/login etc.).
const router = Router();

for (const resource of importResourceNames) {
  const guard = [authenticate, authorize(importResources[resource].permission), uploadCsv] as const;
  const name: ImportResourceName = resource;

  router.post(`/${name}/import/preview`, ...guard, (req, res: Response) => {
    sendSuccess(res, { data: importsService.preview(name, req.body) });
  });
  router.post(`/${name}/import/validate`, ...guard, (req, res: Response) => {
    sendSuccess(res, { data: importsService.validate(name, req.body, mappingHeader(req)) });
  });
  router.post(`/${name}/import/commit`, ...guard, async (req, res: Response) => {
    const job = await importsService.commit(name, req.body, mappingHeader(req), {
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      permissions: req.auth.permissions,
    });
    sendSuccess(res, { statusCode: 202, message: 'Import queued', data: { jobId: job.id } });
  });
}

router.get(
  '/imports/:jobId',
  authenticate,
  validateRequest({ params: jobParamsSchema }),
  async (req: ValidatedRequest<{ params: JobParams }>, res: Response) => {
    const data = await importsService.getJob({ organizationId: req.auth.organizationId, userId: req.auth.userId, id: req.validated.params.jobId });
    sendSuccess(res, { data });
  },
);

router.get(
  '/imports/:jobId/errors.csv',
  authenticate,
  validateRequest({ params: jobParamsSchema }),
  async (req: ValidatedRequest<{ params: JobParams }>, res: Response) => {
    const file = await importsService.getErrorsCsv({ organizationId: req.auth.organizationId, userId: req.auth.userId, id: req.validated.params.jobId });
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/csv').attachment(file.fileName).send(file.content);
  },
);

export default router;
