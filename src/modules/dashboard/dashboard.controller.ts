import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { dashboardService } from './dashboard.service.js';
import type { SummaryQuery } from './dashboard.validation.js';

class DashboardController {
  async summary(req: ValidatedRequest<{ query: SummaryQuery }>, res: Response) {
    const { organizationId, userId, permissions } = req.auth;
    sendSuccess(res, { data: await dashboardService.getSummary({ organizationId, userId, permissions, query: req.validated.query }) });
  }
}

export const dashboardController = new DashboardController();
