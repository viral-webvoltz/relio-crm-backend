import { Router, type Request, type Response } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { sessionOnly } from '@/middleware/session-only.js';
import { validateRequest, type ValidatedRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { apiKeysService } from './api-keys.service.js';
import { createApiKeySchema, type CreateApiKeyInput } from './api-keys.validation.js';

// Managing keys needs a signed-in person with settings access. A key can never be used to make or revoke keys.
const router = Router();
router.use(authenticate, sessionOnly, authorize('settings.manage'));

router.get('/', async (req: Request, res: Response) => {
  sendSuccess(res, { data: await apiKeysService.list(req.auth.organizationId) });
});

// What this person may put on a key.
router.get('/scopes', (req: Request, res: Response) => {
  sendSuccess(res, { data: apiKeysService.scopesFor(req.auth.permissions) });
});

router.post('/', validateRequest({ body: createApiKeySchema }), async (req: ValidatedRequest<{ body: CreateApiKeyInput }>, res: Response) => {
  const { organizationId, userId, permissions } = req.auth;
  const data = await apiKeysService.create({ organizationId, userId, permissions, input: req.validated.body });
  sendSuccess(res, { statusCode: 201, message: 'API key created. Copy it now: it will not be shown again.', data });
});

router.delete('/:id', validateRequest({ params: idParamSchema }), async (req: ValidatedRequest<{ params: { id: string } }>, res: Response) => {
  await apiKeysService.revoke({ organizationId: req.auth.organizationId, userId: req.auth.userId, id: req.validated.params.id });
  sendSuccess(res, { message: 'API key revoked' });
});

export default router;
