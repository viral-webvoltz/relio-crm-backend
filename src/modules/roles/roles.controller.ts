import type { Response } from 'express';
import { permissionKeys } from '@/shared/constants/permissions.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { rolesService } from './roles.service.js';
import type { CreateRoleInput, UpdateRoleInput } from './roles.validation.js';

class RolesController {
  async list(req: ValidatedRequest, res: Response) {
    const roles = await rolesService.listRoles({ organizationId: req.auth.organizationId });
    sendSuccess(res, { data: { roles, allPermissions: permissionKeys } });
  }

  async create(req: ValidatedRequest<{ body: CreateRoleInput }>, res: Response) {
    const role = await rolesService.createRole({ organizationId: req.auth.organizationId, actor: req.auth, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Role created', data: role });
  }

  async update(req: ValidatedRequest<{ params: { id: string }; body: UpdateRoleInput }>, res: Response) {
    await rolesService.updateRole({ organizationId: req.auth.organizationId, actor: req.auth, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Role updated' });
  }

  async remove(req: ValidatedRequest<{ params: { id: string } }>, res: Response) {
    await rolesService.deleteRole({ organizationId: req.auth.organizationId, actor: req.auth, id: req.validated.params.id });
    sendSuccess(res, { message: 'Role deleted' });
  }
}

export const rolesController = new RolesController();
