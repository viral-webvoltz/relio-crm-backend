import { hashPassword } from '@/shared/utils/password.js';
import { withTransaction } from '@/config/database.js';
import { audit } from '@/shared/utils/audit.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import type { AuthContext } from '@/shared/types/auth.js';
import { rolesService } from '@/modules/roles/roles.service.js';
import { rolesRepository } from '@/modules/roles/roles.repository.js';
import { usersRepository } from './users.repository.js';
import type { CreateUserInput, UpdateUserInput } from './users.validation.js';

type Actor = Pick<AuthContext, 'userId' | 'organizationId' | 'permissions'>;

class UsersService {
  async listUsers({ organizationId }: { organizationId: string }) {
    const rows = await usersRepository.list({ organizationId });
    const assignments = await rolesRepository.listUserAssignments({ organizationId });
    return rows.map((u) => ({
      ...u,
      roles: assignments.filter((a) => a.userId === u.id).map((a) => ({ id: a.roleId, name: a.roleName })),
    }));
  }

  // Names only, so colleagues can be picked (e.g. as a lead assignee) without users.manage.
  async listUserOptions({ organizationId }: { organizationId: string }) {
    return usersRepository.listActiveOptions({ organizationId });
  }

  async createUser({ actor, input }: { actor: Actor; input: CreateUserInput }) {
    const selected = await this.loadRoles({ organizationId: actor.organizationId, roleIds: input.roleIds });
    await this.assertOwnerRoleChangeAllowed({ actor, touchesOwnerRole: selected.some((r) => r.isSystem) });
    await rolesService.assertCanGrantRoles({ actor, roleIds: selected.map((r) => r.id) });
    const passwordHash = await hashPassword(input.password);

    return withTransaction(async (tx) => {
      const user = await usersRepository.create({ organizationId: actor.organizationId, email: input.email, fullName: input.fullName, passwordHash }, tx);
      await rolesRepository.insertUserRoles({ userId: user.id, roleIds: selected.map((r) => r.id) }, tx);
      await audit(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'user.created',
          targetType: 'user',
          targetId: user.id,
          metadata: { roleIds: input.roleIds },
        },
        tx,
      );
      return user;
    });
  }

  async updateUser({ actor, id, input }: { actor: Actor; id: string; input: UpdateUserInput }) {
    const target = await usersRepository.findById({ organizationId: actor.organizationId, id });
    if (!target) throw new NotFoundError('User not found');

    const targetIsOwner = await rolesRepository.userHasSystemRole({ userId: id });
    const nextRoles = input.roleIds ? await this.loadRoles({ organizationId: actor.organizationId, roleIds: input.roleIds }) : null;
    const nextIsOwner = nextRoles ? nextRoles.some((r) => r.isSystem) : targetIsOwner;
    const losesOwnerAccess = targetIsOwner && (!nextIsOwner || input.isActive === false);

    if (input.isActive === false && id === actor.userId) {
      throw new ConflictError('You cannot deactivate your own account', 'SELF_DEACTIVATION');
    }
    // Any edit of an owner (password reset included) or any hand-out of owner access needs an owner.
    await this.assertOwnerRoleChangeAllowed({ actor, touchesOwnerRole: targetIsOwner || nextIsOwner });
    if (nextRoles) await rolesService.assertCanGrantRoles({ actor, roleIds: nextRoles.map((r) => r.id) });
    if (losesOwnerAccess && (await rolesRepository.countOtherActiveOwners({ organizationId: actor.organizationId, excludeUserId: id })) === 0) {
      throw new ConflictError('The organization must keep at least one active owner', 'LAST_OWNER');
    }

    await withTransaction(async (tx) => {
      const changes = {
        ...(input.fullName !== undefined && { fullName: input.fullName }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.password && { passwordHash: await hashPassword(input.password) }),
      };
      if (Object.keys(changes).length) await usersRepository.update({ organizationId: actor.organizationId, id, changes }, tx);
      if (nextRoles) {
        await rolesRepository.deleteUserRoles({ userId: id }, tx);
        await rolesRepository.insertUserRoles({ userId: id, roleIds: nextRoles.map((r) => r.id) }, tx);
      }
      if (input.password || input.isActive === false) await usersRepository.deleteSessions({ userId: id }, tx);
    });
    await audit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: input.password ? 'user.password_reset' : 'user.updated',
      targetType: 'user',
      targetId: id,
      metadata: { roleIds: input.roleIds, isActive: input.isActive, fullName: input.fullName },
    });
  }

  private async loadRoles({ organizationId, roleIds }: { organizationId: string; roleIds: string[] }) {
    const found = await rolesRepository.findByIds({ organizationId, roleIds });
    if (found.length !== new Set(roleIds).size) throw new BadRequestError('One or more roles do not exist', 'INVALID_ROLE');
    return found;
  }

  // Only owners may hand out or take away the owner role, otherwise an admin could promote themselves.
  private async assertOwnerRoleChangeAllowed({ actor, touchesOwnerRole }: { actor: Actor; touchesOwnerRole: boolean }) {
    if (touchesOwnerRole && !(await rolesRepository.userHasSystemRole({ userId: actor.userId }))) {
      throw new ForbiddenError('Only an owner can change owner access', 'FORBIDDEN');
    }
  }
}

export const usersService = new UsersService();
