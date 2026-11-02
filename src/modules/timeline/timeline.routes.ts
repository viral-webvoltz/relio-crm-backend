import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { listQuerySchema, pageMeta } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { mergeTimeline } from './timeline.merge.js';
import { timelineRepository } from './timeline.repository.js';

const paramsSchema = z.object({ contactId: z.uuid() });
const querySchema = listQuerySchema.pick({ page: true, limit: true });

const router = Router();

router.use(authenticate);
router.get(
  '/contacts/:contactId',
  authorize('contacts.view'),
  validateRequest({ params: paramsSchema, query: querySchema }),
  async (req: ValidatedRequest<{ params: z.infer<typeof paramsSchema>; query: z.infer<typeof querySchema> }>, res: Response) => {
    const scope = { organizationId: req.auth.organizationId, contactId: req.validated.params.contactId };
    const query = req.validated.query;
    if (!(await timelineRepository.contactExists(scope))) throw new NotFoundError('Contact not found');
    const { rows, total } = mergeTimeline(await timelineRepository.sources({ ...scope, permissions: req.auth.permissions }), query);
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  },
);

export default router;
