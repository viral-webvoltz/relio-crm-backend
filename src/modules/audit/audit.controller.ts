import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { auditService } from './audit.service.js';
import type { AuditListQuery } from './audit.validation.js';

class AuditController {
  async list(req: ValidatedRequest<{ query: AuditListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await auditService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta({ ...query, search: undefined, sort: undefined, dir: undefined }, total) });
  }
}

export const auditController = new AuditController();
