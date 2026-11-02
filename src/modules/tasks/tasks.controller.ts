import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { assertBatchPermission } from '@/shared/batch/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { tasksService } from './tasks.service.js';
import type { CreateTaskInput, TaskListQuery, UpdateTaskInput, BatchTasksInput } from './tasks.validation.js';

type IdParams = { id: string };

class TasksController {
  async list(req: ValidatedRequest<{ query: TaskListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await tasksService.listTasks({ organizationId: req.auth.organizationId, userId: req.auth.userId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await tasksService.getTask({ organizationId: req.auth.organizationId, id: req.validated.params.id }) });
  }

  async create(req: ValidatedRequest<{ body: CreateTaskInput }>, res: Response) {
    const task = await tasksService.createTask({ organizationId: req.auth.organizationId, userId: req.auth.userId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Task created', data: task });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateTaskInput }>, res: Response) {
    const task = await tasksService.updateTask({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      input: req.validated.body,
      actorId: req.auth.userId,
    });
    sendSuccess(res, { message: 'Task updated', data: task });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await tasksService.deleteTask({ organizationId: req.auth.organizationId, id: req.validated.params.id, userId: req.auth.userId });
    sendSuccess(res, { message: 'Task deleted' });
  }

  async trash(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await tasksService.listDeletedTasks({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async restore(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await tasksService.restoreTask({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Task restored', data });
  }

  async batch(req: ValidatedRequest<{ body: BatchTasksInput }>, res: Response) {
    const input = req.validated.body;
    assertBatchPermission(req.auth, input.action === 'delete' ? 'tasks.delete' : 'tasks.update');
    sendSuccess(res, { data: await tasksService.batch({ organizationId: req.auth.organizationId, userId: req.auth.userId, input }) });
  }
}

export const tasksController = new TasksController();
