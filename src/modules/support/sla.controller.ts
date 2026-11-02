import type { Request, Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { slaService } from './sla.service.js';
import type { SlaPolicyInput, SlaSummaryQuery } from './sla.validation.js';

class SlaController {
  async getPolicy(req: Request, res: Response) {
    sendSuccess(res, { data: await slaService.getPolicy(req.auth.organizationId) });
  }

  async putPolicy(req: ValidatedRequest<{ body: SlaPolicyInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, { message: 'SLA policy saved', data: await slaService.putPolicy({ organizationId, userId, input: req.validated.body }) });
  }

  async summary(req: ValidatedRequest<{ query: SlaSummaryQuery }>, res: Response) {
    sendSuccess(res, { data: await slaService.summary({ organizationId: req.auth.organizationId, days: req.validated.query.days }) });
  }
}

export const slaController = new SlaController();
