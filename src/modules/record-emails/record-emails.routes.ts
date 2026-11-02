import type { Response } from 'express';
import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest, type ValidatedRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import type { EmailRecordType } from './record-emails.repository.js';
import { recordEmailsService } from './record-emails.service.js';
import { sendRecordEmailSchema, type SendRecordEmailInput } from './record-emails.validation.js';

// Mounted at the API root, before the leads and contacts routers: authenticate per route, never router.use (it would gate every path).
const router = Router();

type Params = { id: string };

function mount(type: EmailRecordType, path: 'leads' | 'contacts') {
  router.post(
    `/${path}/:id/email`,
    authenticate,
    authorize(`${path}.update`),
    idempotent,
    validateRequest({ params: idParamSchema, body: sendRecordEmailSchema }),
    async (req: ValidatedRequest<{ params: Params; body: SendRecordEmailInput }>, res: Response) => {
      const { organizationId, userId } = req.auth;
      const data = await recordEmailsService.send({ organizationId, userId, type, id: req.validated.params.id, input: req.validated.body });
      sendSuccess(res, { statusCode: 202, message: 'Email queued', data });
    },
  );

  router.get(`/${path}/:id/emails`, authenticate, authorize(`${path}.view`), validateRequest({ params: idParamSchema }), async (req: ValidatedRequest<{ params: Params }>, res: Response) => {
    sendSuccess(res, { data: await recordEmailsService.list({ organizationId: req.auth.organizationId, type, id: req.validated.params.id }) });
  });
}

mount('lead', 'leads');
mount('contact', 'contacts');

export default router;
