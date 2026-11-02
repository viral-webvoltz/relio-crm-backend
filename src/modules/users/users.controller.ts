import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { usersService } from './users.service.js';
import type { CreateUserInput, UpdateUserInput } from './users.validation.js';

class UsersController {
  async listOptions(req: ValidatedRequest, res: Response) {
    sendSuccess(res, { data: await usersService.listUserOptions({ organizationId: req.auth.organizationId }) });
  }

  async list(req: ValidatedRequest, res: Response) {
    sendSuccess(res, { data: await usersService.listUsers({ organizationId: req.auth.organizationId }) });
  }

  async create(req: ValidatedRequest<{ body: CreateUserInput }>, res: Response) {
    const user = await usersService.createUser({ actor: req.auth, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'User created', data: user });
  }

  async update(req: ValidatedRequest<{ params: { id: string }; body: UpdateUserInput }>, res: Response) {
    await usersService.updateUser({ actor: req.auth, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'User updated' });
  }
}

export const usersController = new UsersController();
