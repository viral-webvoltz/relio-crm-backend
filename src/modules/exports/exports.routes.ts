import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { exportResourceNames, exportResources } from './exports.registry.js';
import type { ExportResourceName } from './exports.registry.js';
import { exportsService } from './exports.service.js';

const createExportSchema = z.object({ resource: z.enum(exportResourceNames), query: z.record(z.string(), z.unknown()).default({}) });
const jobParamsSchema = z.object({ jobId: z.uuid() });
const downloadQuerySchema = z.object({ expires: z.coerce.number().int(), sig: z.string().regex(/^[0-9a-f]{64}$/i) });
const exportFormatSchema = z.object({ format: z.literal('csv').default('csv') });

type JobParams = z.infer<typeof jobParamsSchema>;

const quickExport =
  (resource: ExportResourceName): RequestHandler =>
  async (req: Request, res: Response) => {
    exportFormatSchema.parse(req.query);
    await exportsService.streamCsv({ organizationId: req.auth.organizationId, userId: req.auth.userId, resource, query: req.query, res });
  };

// Mounted at the API root, so authenticate is applied per route (a router-level one would also gate /auth/login etc.).
const router = Router();

for (const resource of exportResourceNames) {
  router.get(`/${resource}/export`, authenticate, authorize(exportResources[resource].permission), quickExport(resource));
}

router.post(
  '/exports',
  authenticate,
  idempotent,
  validateRequest({ body: createExportSchema }),
  async (req: ValidatedRequest<{ body: z.infer<typeof createExportSchema> }>, res: Response) => {
    const { resource, query } = req.validated.body;
    exportsService.assertCanExport(req.auth.permissions, resource);
    const job = await exportsService.createJob({ organizationId: req.auth.organizationId, userId: req.auth.userId, resource, query });
    sendSuccess(res, { statusCode: 202, message: 'Export queued', data: { jobId: job.id } });
  },
);

router.get(
  '/exports/:jobId',
  authenticate,
  validateRequest({ params: jobParamsSchema }),
  async (req: ValidatedRequest<{ params: JobParams }>, res: Response) => {
    const data = await exportsService.getJob({ organizationId: req.auth.organizationId, userId: req.auth.userId, id: req.validated.params.jobId });
    sendSuccess(res, { data });
  },
);

router.get(
  '/exports/:jobId/download',
  authenticate,
  validateRequest({ params: jobParamsSchema, query: downloadQuerySchema }),
  async (req: ValidatedRequest<{ params: JobParams; query: z.infer<typeof downloadQuerySchema> }>, res: Response) => {
    const { expires, sig } = req.validated.query;
    const file = await exportsService.getDownload({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      id: req.validated.params.jobId,
      expires,
      sig,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/csv').attachment(file.fileName).send(file.content);
  },
);

export default router;
