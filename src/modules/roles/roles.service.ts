import { withTransaction, type DbTransaction } from '@/config/database.js';
import { audit } from '@/shared/utils/audit.js';
import type { AuthContext } from '@/shared/types/auth.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { rolesRepository } from './roles.repository.js';
import type { CreateRoleInput, UpdateRoleInput } from './roles.validation.js';

class RolesService {
  async listRoles({ organizationId }: { organizationId: string }) {
    const rows = await rolesRepository.listWithPermissions({ organizationId });
    const userCounts = await rolesRepository.countUsersByRole({ organizationId });

    const byId = new Map<string, { id: string; name: string; isSystem: boolean; permissions: string[]; userCount: number }>();
    for (const row of rows) {
      const role = byId.get(row.id) ?? {
        id: row.id,
        name: row.name,
        isSystem: row.isSystem,
        permissions: [],
        userCount: userCounts.find((c) => c.roleId === row.id)?.value ?? 0,
      };
      if (row.permission) role.permissions.push(row.permission);
      byId.set(row.id, role);
    }
    return [...byId.values()].sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
  }

  // Nobody can hand out a permission they do not hold themselves.
  assertCanGrantPermissions({ actor, keys }: { actor: Pick<AuthContext, 'permissions'>; keys: readonly string[] }) {
    if (keys.some((key) => !actor.permissions.some((p) => p === key))) throw new ForbiddenError('You cannot grant permissions you do not have', 'FORBIDDEN');
  }

  async assertCanGrantRoles({ actor, roleIds }: { actor: Pick<AuthContext, 'permissions'>; roleIds: string[] }) {
    this.assertCanGrantPermissions({ actor, keys: await rolesRepository.listPermissionKeysForRoles({ roleIds }) });
  }

  async createRole({ organizationId, actor, input }: { organizationId: string; actor: AuthContext; input: CreateRoleInput }) {
    this.assertCanGrantPermissions({ actor, keys: input.permissions });
    return withTransaction(async (tx) => {
      const role = await rolesRepository.create({ organizationId, name: input.name }, tx);
      await this.setPermissions({ roleId: role.id, keys: input.permissions }, tx);
      await audit(
        {
          organizationId,
          actorUserId: actor.userId,
          action: 'role.created',
          targetType: 'role',
          targetId: role.id,
          metadata: { name: input.name, permissions: input.permissions },
        },
        tx,
      );
      return role;
    });
  }

  async updateRole({ organizationId, actor, id, input }: { organizationId: string; actor: AuthContext; id: string; input: UpdateRoleInput }) {
    await this.assertEditable({ organizationId, id });
    if (input.permissions) this.assertCanGrantPermissions({ actor, keys: input.permissions });
    await withTransaction(async (tx) => {
      if (input.name) await rolesRepository.updateName({ organizationId, id, name: input.name }, tx);
      if (input.permissions) await this.setPermissions({ roleId: id, keys: input.permissions }, tx);
      await audit(
        {
          organizationId,
          actorUserId: actor.userId,
          action: 'role.updated',
          targetType: 'role',
          targetId: id,
          metadata: { name: input.name, permissions: input.permissions },
        },
        tx,
      );
    });
  }

  async deleteRole({ organizationId, actor, id }: { organizationId: string; actor: AuthContext; id: string }) {
    await this.assertEditable({ organizationId, id });
    if ((await rolesRepository.countAssignedUsers({ roleId: id })) > 0) {
      throw new ConflictError('Reassign the users with this role before deleting it', 'ROLE_IN_USE');
    }
    await rolesRepository.delete({ organizationId, id });
    await audit({ organizationId, actorUserId: actor.userId, action: 'role.deleted', targetType: 'role', targetId: id });
  }

  private async assertEditable({ organizationId, id }: { organizationId: string; id: string }) {
    const role = await rolesRepository.findById({ organizationId, id });
    if (!role) throw new NotFoundError('Role not found');
    if (role.isSystem) throw new ConflictError('The owner role cannot be changed', 'SYSTEM_ROLE');
  }

  private async setPermissions({ roleId, keys }: { roleId: string; keys: string[] }, tx: DbTransaction) {
    await rolesRepository.deleteRolePermissions({ roleId }, tx);
    if (keys.length === 0) return;
    const ids = await rolesRepository.findPermissionIds({ keys }, tx);
    await rolesRepository.insertRolePermissions({ roleId, permissionIds: ids.map((p) => p.id) }, tx);
  }
}

export const rolesService = new RolesService();
