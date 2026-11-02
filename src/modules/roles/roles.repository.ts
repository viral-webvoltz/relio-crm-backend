import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schema/index.js';

class RolesRepository {
  async listWithPermissions({ organizationId }: { organizationId: string }) {
    return db
      .select({ id: roles.id, name: roles.name, isSystem: roles.isSystem, permission: permissions.key })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(roles.organizationId, organizationId));
  }

  async countUsersByRole({ organizationId }: { organizationId: string }) {
    return db
      .select({ roleId: userRoles.roleId, value: count() })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(roles.organizationId, organizationId))
      .groupBy(userRoles.roleId);
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }) {
    const [role] = await db
      .select({ id: roles.id, isSystem: roles.isSystem })
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), eq(roles.id, id)));
    return role;
  }

  async findByIds({ organizationId, roleIds }: { organizationId: string; roleIds: string[] }) {
    return db
      .select({ id: roles.id, isSystem: roles.isSystem })
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, roleIds)));
  }

  async findByName({ organizationId, name }: { organizationId: string; name: string }, executor: DbExecutor = db) {
    const [role] = await executor
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), eq(roles.name, name)));
    return role;
  }

  async create({ organizationId, name, isSystem }: { organizationId: string; name: string; isSystem?: boolean }, executor: DbExecutor = db) {
    const [role] = await executor
      .insert(roles)
      .values({ organizationId, name, isSystem })
      .returning({ id: roles.id, organizationId: roles.organizationId, name: roles.name, isSystem: roles.isSystem, createdAt: roles.createdAt });
    return role!;
  }

  // Returns undefined when the organization already has a role with this name.
  async createIfMissing({ organizationId, name }: { organizationId: string; name: string }, executor: DbExecutor = db) {
    const [role] = await executor.insert(roles).values({ organizationId, name }).onConflictDoNothing().returning({ id: roles.id });
    return role;
  }

  async updateName({ organizationId, id, name }: { organizationId: string; id: string; name: string }, executor: DbExecutor = db) {
    await executor
      .update(roles)
      .set({ name })
      .where(and(eq(roles.organizationId, organizationId), eq(roles.id, id)));
  }

  async delete({ organizationId, id }: { organizationId: string; id: string }) {
    await db.delete(roles).where(and(eq(roles.organizationId, organizationId), eq(roles.id, id)));
  }

  async countAssignedUsers({ roleId }: { roleId: string }) {
    const [row] = await db.select({ value: count() }).from(userRoles).where(eq(userRoles.roleId, roleId));
    return row?.value ?? 0;
  }

  async ensurePermissionKeys({ keys }: { keys: readonly string[] }, executor: DbExecutor = db) {
    await executor
      .insert(permissions)
      .values(keys.map((key) => ({ key })))
      .onConflictDoNothing();
  }

  async findPermissionIds({ keys }: { keys: readonly string[] }, executor: DbExecutor = db) {
    return executor
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.key, [...keys]));
  }

  async listPermissionKeysForRoles({ roleIds }: { roleIds: string[] }) {
    const rows = await db
      .selectDistinct({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(inArray(rolePermissions.roleId, roleIds));
    return rows.map((r) => r.key);
  }

  async deleteRolePermissions({ roleId }: { roleId: string }, executor: DbExecutor = db) {
    await executor.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  }

  async insertRolePermissions({ roleId, permissionIds }: { roleId: string; permissionIds: string[] }, executor: DbExecutor = db) {
    if (permissionIds.length === 0) return;
    await executor.insert(rolePermissions).values(permissionIds.map((permissionId) => ({ roleId, permissionId })));
  }

  async listUserAssignments({ organizationId }: { organizationId: string }) {
    return db
      .select({ userId: userRoles.userId, roleId: roles.id, roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(roles.organizationId, organizationId));
  }

  async deleteUserRoles({ userId }: { userId: string }, executor: DbExecutor = db) {
    await executor.delete(userRoles).where(eq(userRoles.userId, userId));
  }

  async insertUserRoles({ userId, roleIds }: { userId: string; roleIds: string[] }, executor: DbExecutor = db) {
    await executor.insert(userRoles).values(roleIds.map((roleId) => ({ userId, roleId })));
  }

  async userHasSystemRole({ userId }: { userId: string }) {
    const [row] = await db
      .select({ id: roles.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(userRoles.userId, userId), eq(roles.isSystem, true)));
    return Boolean(row);
  }

  async countOtherActiveOwners({ organizationId, excludeUserId }: { organizationId: string; excludeUserId: string }) {
    const [row] = await db
      .select({ value: count() })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(roles.organizationId, organizationId), eq(roles.isSystem, true), eq(users.isActive, true), ne(users.id, excludeUserId)));
    return row?.value ?? 0;
  }
}

export const rolesRepository = new RolesRepository();
