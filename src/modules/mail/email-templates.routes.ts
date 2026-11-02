import type { Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest, type ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { emailTemplatesService } from './email-templates.service.js';
import { MAX_BODY, MAX_SUBJECT, templateKeys } from './mail.templates.js';

const keyParam = z.object({ key: z.enum(templateKeys) });
const templateBody = z.object({
  subject: z.string().trim().min(1).max(MAX_SUBJECT),
  bodyHtml: z.string().min(1).max(MAX_BODY),
  bodyText: z.string().min(1).max(MAX_BODY),
});
type Key = { key: (typeof templateKeys)[number] };
type Body = z.infer<typeof templateBody>;

// Mounted at /email-templates.
const router = Router();
router.use(authenticate, authorize('settings.manage'));

router.get('/', async (req, res: Response) => {
  sendSuccess(res, { data: await emailTemplatesService.list(req.auth.organizationId) });
});

router.put('/:key', validateRequest({ params: keyParam, body: templateBody }), async (req: ValidatedRequest<{ params: Key; body: Body }>, res: Response) => {
  const data = await emailTemplatesService.put({
    organizationId: req.auth.organizationId,
    userId: req.auth.userId,
    key: req.validated.params.key,
    input: req.validated.body,
  });
  sendSuccess(res, { message: 'Template saved', data });
});

router.delete('/:key', validateRequest({ params: keyParam }), async (req: ValidatedRequest<{ params: Key }>, res: Response) => {
  await emailTemplatesService.reset(req.auth.organizationId, req.validated.params.key);
  sendSuccess(res, { message: 'Template reset to default' });
});

// Optional body previews an unsaved draft; without one the current template is rendered.
router.post(
  '/:key/preview',
  validateRequest({ params: keyParam, body: templateBody.optional() }),
  async (req: ValidatedRequest<{ params: Key; body: Body | undefined }>, res: Response) => {
    sendSuccess(res, { data: await emailTemplatesService.preview(req.auth.organizationId, req.validated.params.key, req.validated.body) });
  },
);

export default router;
