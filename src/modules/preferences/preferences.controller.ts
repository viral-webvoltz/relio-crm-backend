import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { preferencesService } from './preferences.service.js';
import type { KeyParams, PutPreferenceInput } from './preferences.validation.js';

class PreferencesController {
  async list(req: ValidatedRequest, res: Response) {
    sendSuccess(res, { data: await preferencesService.list({ userId: req.auth.userId }) });
  }

  async set(req: ValidatedRequest<{ params: KeyParams; body: PutPreferenceInput }>, res: Response) {
    const data = await preferencesService.set({
      userId: req.auth.userId,
      organizationId: req.auth.organizationId,
      key: req.validated.params.key,
      value: req.validated.body.value,
    });
    sendSuccess(res, { message: 'Preference saved', data });
  }
}

export const preferencesController = new PreferencesController();
