import type { Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest, type ValidatedRequest } from '@/middleware/validate-request.js';
import { AppError } from '@/shared/errors/index.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { canSendMail, mailService } from './mail.service.js';

const sendInvoiceSchema = z.object({ to: z.email().max(254).optional() });

// Mounted at the API root, before the invoices router: authenticate per route, never router.use, or it would gate every path (including /auth/login).
const router = Router();

router.post(
  '/invoices/:id/send',
  authenticate,
  authorize('invoices.create'),
  idempotent,
  validateRequest({ params: idParamSchema, body: sendInvoiceSchema }),
  async (req: ValidatedRequest<{ params: { id: string }; body: z.infer<typeof sendInvoiceSchema> }>, res: Response) => {
    if (!(await canSendMail(req.auth.organizationId))) throw new AppError('Email is not configured', 503, 'MAIL_NOT_CONFIGURED');
    await mailService.sendInvoice({ organizationId: req.auth.organizationId, id: req.validated.params.id, to: req.validated.body.to });
    sendSuccess(res, { statusCode: 202, message: 'Invoice email queued' });
  },
);

export default router;
