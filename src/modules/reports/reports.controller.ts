import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { reportsService } from './reports.service.js';
import type { CreateSavedInput, CreateScheduleInput, ReportQuery, UpdateSavedInput, UpdateScheduleInput } from './reports.validation.js';

type IdParams = { id: string };

class ReportsController {
  async revenueByMonth(req: ValidatedRequest<{ query: ReportQuery }>, res: Response) {
    sendSuccess(res, { data: await reportsService.revenueByMonth({ organizationId: req.auth.organizationId, query: req.validated.query }) });
  }

  async pipelineVelocity(req: ValidatedRequest<{ query: ReportQuery }>, res: Response) {
    sendSuccess(res, { data: await reportsService.pipelineVelocity({ organizationId: req.auth.organizationId, query: req.validated.query }) });
  }

  async leadsFunnel(req: ValidatedRequest<{ query: ReportQuery }>, res: Response) {
    sendSuccess(res, { data: await reportsService.leadsFunnel({ organizationId: req.auth.organizationId, query: req.validated.query }) });
  }

  async listSaved(req: ValidatedRequest, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, { data: await reportsService.listSaved({ organizationId, userId }) });
  }

  async createSaved(req: ValidatedRequest<{ body: CreateSavedInput }>, res: Response) {
    const { organizationId, userId, permissions } = req.auth;
    const data = await reportsService.createSaved({ organizationId, userId, permissions, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Report saved', data });
  }

  async updateSaved(req: ValidatedRequest<{ params: IdParams; body: UpdateSavedInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    const data = await reportsService.updateSaved({ organizationId, userId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Report updated', data });
  }

  async removeSaved(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const { organizationId, userId } = req.auth;
    await reportsService.removeSaved({ organizationId, userId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Report deleted' });
  }

  async runSaved(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const { organizationId, userId, permissions } = req.auth;
    const result = await reportsService.runSaved({ organizationId, userId, permissions, id: req.validated.params.id });
    sendSuccess(res, { data: result });
  }

  async listSchedules(req: ValidatedRequest, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, { data: await reportsService.listSchedules({ organizationId, userId }) });
  }

  async createSchedule(req: ValidatedRequest<{ body: CreateScheduleInput }>, res: Response) {
    const { organizationId, userId, permissions } = req.auth;
    const data = await reportsService.createSchedule({ organizationId, userId, permissions, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Schedule created', data });
  }

  async updateSchedule(req: ValidatedRequest<{ params: IdParams; body: UpdateScheduleInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    const data = await reportsService.updateSchedule({ organizationId, userId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Schedule updated', data });
  }

  async removeSchedule(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const { organizationId, userId } = req.auth;
    await reportsService.removeSchedule({ organizationId, userId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Schedule deleted' });
  }
}

export const reportsController = new ReportsController();
