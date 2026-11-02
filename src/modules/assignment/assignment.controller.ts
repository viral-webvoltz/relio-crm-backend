import type { Request, Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { assignmentService } from './assignment.service.js';
import type { AssignmentResource, CreateRuleInput, CreateTeamInput, UpdateRuleInput, UpdateTeamInput } from './assignment.validation.js';

type IdParams = { id: string };

class AssignmentController {
  async listTeams(req: Request, res: Response) {
    sendSuccess(res, { data: await assignmentService.listTeams(req.auth.organizationId) });
  }

  async getTeam(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await assignmentService.getTeam(req.auth.organizationId, req.validated.params.id) });
  }

  async createTeam(req: ValidatedRequest<{ body: CreateTeamInput }>, res: Response) {
    sendSuccess(res, {
      statusCode: 201,
      message: 'Team created',
      data: await assignmentService.createTeam({ organizationId: req.auth.organizationId, input: req.validated.body }),
    });
  }

  async updateTeam(req: ValidatedRequest<{ params: IdParams; body: UpdateTeamInput }>, res: Response) {
    const data = await assignmentService.updateTeam({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Team updated', data });
  }

  async setMembers(req: ValidatedRequest<{ params: IdParams; body: { userIds: string[] } }>, res: Response) {
    const data = await assignmentService.setMembers({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      userIds: req.validated.body.userIds,
    });
    sendSuccess(res, { message: 'Members updated', data });
  }

  async removeTeam(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await assignmentService.removeTeam({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Team deleted' });
  }

  async listRules(req: ValidatedRequest<{ query: { resource?: AssignmentResource | undefined } }>, res: Response) {
    sendSuccess(res, { data: await assignmentService.listRules({ organizationId: req.auth.organizationId, resource: req.validated.query.resource }) });
  }

  async createRule(req: ValidatedRequest<{ body: CreateRuleInput }>, res: Response) {
    sendSuccess(res, {
      statusCode: 201,
      message: 'Rule created',
      data: await assignmentService.createRule({ organizationId: req.auth.organizationId, input: req.validated.body }),
    });
  }

  async updateRule(req: ValidatedRequest<{ params: IdParams; body: UpdateRuleInput }>, res: Response) {
    const data = await assignmentService.updateRule({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Rule updated', data });
  }

  async removeRule(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await assignmentService.removeRule({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Rule deleted' });
  }

  async reorder(req: ValidatedRequest<{ body: { resource: AssignmentResource; ids: string[] } }>, res: Response) {
    sendSuccess(res, { message: 'Order saved', data: await assignmentService.reorder({ organizationId: req.auth.organizationId, ...req.validated.body }) });
  }

  // Dry run: who a record like this would go to, without moving any rotation on.
  async test(req: ValidatedRequest<{ body: { resource: AssignmentResource; sample: Record<string, unknown> } }>, res: Response) {
    const { resource, sample } = req.validated.body;
    sendSuccess(res, { data: { match: await assignmentService.pick({ organizationId: req.auth.organizationId, resource, values: sample, dryRun: true }) } });
  }

  async applyToUnassigned(req: ValidatedRequest<{ body: { resource: AssignmentResource; limit: number } }>, res: Response) {
    sendSuccess(res, { message: 'Done', data: await assignmentService.applyToUnassigned({ organizationId: req.auth.organizationId, ...req.validated.body }) });
  }
}

export const assignmentController = new AssignmentController();
