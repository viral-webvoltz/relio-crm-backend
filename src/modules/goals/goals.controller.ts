import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { goalsService } from './goals.service.js';
import type { CreateGoalInput, GoalListQuery, LeaderboardQuery, UpdateGoalInput } from './goals.validation.js';

type IdParams = { id: string };

class GoalsController {
  async list(req: ValidatedRequest<{ query: GoalListQuery }>, res: Response) {
    sendSuccess(res, { data: await goalsService.list({ organizationId: req.auth.organizationId, query: req.validated.query }) });
  }

  async leaderboard(req: ValidatedRequest<{ query: LeaderboardQuery }>, res: Response) {
    sendSuccess(res, { data: await goalsService.leaderboard({ organizationId: req.auth.organizationId, query: req.validated.query }) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await goalsService.getById({ organizationId: req.auth.organizationId, id: req.validated.params.id }) });
  }

  async create(req: ValidatedRequest<{ body: CreateGoalInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, { statusCode: 201, message: 'Goal created', data: await goalsService.create({ organizationId, userId, input: req.validated.body }) });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateGoalInput }>, res: Response) {
    const data = await goalsService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Goal updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await goalsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Goal deleted' });
  }
}

export const goalsController = new GoalsController();
