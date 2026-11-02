import { Router, type Request, type Response } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { sessionOnly } from '@/middleware/session-only.js';
import { validateRequest, type ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { privacyService } from './privacy.service.js';
import { eraseSubjectSchema, exportSubjectSchema, retentionSchema, type EraseInput, type RetentionInput, type SubjectInput } from './privacy.validation.js';

// Personal-data requests are for a signed-in person with the privacy right: never an API key.
const router = Router();
router.use(authenticate, sessionOnly, authorize('privacy.manage'));

// The request itself names a person (an email address), so the generic request log, which would copy it, is switched off for these routes;
// the service writes its own entry that identifies the request by a short fingerprint instead.
const noRequestLog = (_req: Request, res: Response, next: () => void) => {
  res.locals.skipAudit = true;
  next();
};
router.use(noRequestLog);

// The export is a download, not the usual JSON envelope.
router.post('/export', validateRequest({ body: exportSubjectSchema }), async (req: ValidatedRequest<{ body: SubjectInput }>, res: Response) => {
  const bundle = await privacyService.export({ organizationId: req.auth.organizationId, actorId: req.auth.userId, input: req.validated.body });
  res
    .set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="personal-data-export.json"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .send(JSON.stringify(bundle, null, 2));
});

router.post('/erase', validateRequest({ body: eraseSubjectSchema }), async (req: ValidatedRequest<{ body: EraseInput }>, res: Response) => {
  const result = await privacyService.erase({ organizationId: req.auth.organizationId, actorId: req.auth.userId, input: req.validated.body });
  sendSuccess(res, { message: result.dryRun ? 'Nothing was changed. This is what would be erased.' : 'The data was erased.', data: result });
});

router.get('/retention', async (req: Request, res: Response) => {
  sendSuccess(res, { data: await privacyService.getRetention(req.auth.organizationId) });
});

router.put('/retention', validateRequest({ body: retentionSchema }), async (req: ValidatedRequest<{ body: RetentionInput }>, res: Response) => {
  res.locals.skipAudit = false; // a policy change is worth the ordinary request log too
  sendSuccess(res, {
    message: 'Retention saved',
    data: await privacyService.putRetention({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body }),
  });
});

export default router;
