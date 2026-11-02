import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { activitiesService } from './activities.service.js';
import type { ActivityListQuery, CreateActivityInput, UpdateActivityInput } from './activities.validation.js';

type IdParams = { id: string };

class ActivitiesController {
  async listRecent(req: ValidatedRequest<{ query: { limit: number } }>, res: Response) {
    sendSuccess(res, {
      data: await activitiesService.listRecentActivities({ organizationId: req.auth.organizationId, limit: req.validated.query.limit, actor: req.auth }),
    });
  }

  async list(req: ValidatedRequest<{ query: ActivityListQuery }>, res: Response) {
    sendSuccess(res, {
      data: await activitiesService.listActivitiesFor({ organizationId: req.auth.organizationId, query: req.validated.query, actor: req.auth }),
    });
  }

  async create(req: ValidatedRequest<{ body: CreateActivityInput }>, res: Response) {
    const activity = await activitiesService.createActivity({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      input: req.validated.body,
      actor: req.auth,
    });
    sendSuccess(res, { statusCode: 201, message: 'Activity logged', data: activity });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateActivityInput }>, res: Response) {
    const activity = await activitiesService.updateActivity({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      input: req.validated.body,
      actor: req.auth,
    });
    sendSuccess(res, { message: 'Activity updated', data: activity });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await activitiesService.deleteActivity({ organizationId: req.auth.organizationId, id: req.validated.params.id, actor: req.auth });
    sendSuccess(res, { message: 'Activity deleted' });
  }
}

export const activitiesController = new ActivitiesController();
