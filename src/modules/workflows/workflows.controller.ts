import type { Request, Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta, type ListQuery } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { workflowsService } from './workflows.service.js';
import type { CreateWorkflowInput, SettingsInput, TestWorkflowInput, UpdateWorkflowInput } from './workflows.validation.js';

type IdParams = { id: string };

class WorkflowsController {
  async list(req: Request, res: Response) {
    sendSuccess(res, { data: await workflowsService.list(req.auth.organizationId) });
  }

  async meta(req: Request, res: Response) {
    sendSuccess(res, { data: await workflowsService.meta(req.auth.organizationId) });
  }

  async settings(req: Request, res: Response) {
    sendSuccess(res, { data: await workflowsService.getSettings(req.auth.organizationId) });
  }

  async updateSettings(req: ValidatedRequest<{ body: SettingsInput }>, res: Response) {
    const data = await workflowsService.updateSettings({ organizationId: req.auth.organizationId, input: req.validated.body });
    sendSuccess(res, { message: 'Settings updated', data });
  }

  async queue(req: Request, res: Response) {
    sendSuccess(res, { data: await workflowsService.queueStatus(req.auth.organizationId) });
  }

  async create(req: ValidatedRequest<{ body: CreateWorkflowInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    const data = await workflowsService.create({ organizationId, userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Workflow created', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateWorkflowInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    const data = await workflowsService.update({ organizationId, userId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Workflow updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await workflowsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Workflow deleted' });
  }

  async test(req: ValidatedRequest<{ params: IdParams; body: TestWorkflowInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, { data: await workflowsService.test({ organizationId, userId, id: req.validated.params.id, input: req.validated.body }) });
  }

  async runs(req: ValidatedRequest<{ params: IdParams; query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await workflowsService.listRuns({ organizationId: req.auth.organizationId, id: req.validated.params.id, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }
}

export const workflowsController = new WorkflowsController();
