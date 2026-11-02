// Run after adding permission keys: upserts them, grants all to every Organization Owner and
// Administrator role, and creates any default role an existing organization is missing.
// Other default roles (Sales Manager, ...) are not changed: admins may have customised them.
import { eq, inArray, or } from 'drizzle-orm';
import { administratorRoleName, ensureDefaultRoles } from '@/modules/roles/roles.defaults.js';
import { db, pool } from '@/config/database.js';
import { permissionKeys } from '@/shared/constants/permissions.js';
import { organizations, permissions, rolePermissions, roles } from '@/database/schema/index.js';

await db
  .insert(permissions)
  .values(permissionKeys.map((key) => ({ key })))
  .onConflictDoNothing();
const all = await db
  .select({ id: permissions.id })
  .from(permissions)
  .where(inArray(permissions.key, [...permissionKeys]));
const fullAccessRoles = await db
  .select({ id: roles.id })
  .from(roles)
  .where(or(eq(roles.isSystem, true), eq(roles.name, administratorRoleName)));

for (const role of fullAccessRoles) {
  await db
    .insert(rolePermissions)
    .values(all.map((p) => ({ roleId: role.id, permissionId: p.id })))
    .onConflictDoNothing();
}
for (const org of await db.select({ id: organizations.id }).from(organizations)) {
  await ensureDefaultRoles(db, org.id);
}
console.log(`Synced ${all.length} permissions to ${fullAccessRoles.length} full-access role(s)`);
await pool.end();
