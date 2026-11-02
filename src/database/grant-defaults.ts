// One-off, additive: gives existing Sales Manager / Sales Representative / Viewer roles the
// default permissions for the given groups, e.g. `npm run db:grant-defaults -- tasks activities`.
// It never removes a permission, and is meant for groups no role could have had before.
import { and, eq, inArray } from 'drizzle-orm';
import { defaultRoles } from '@/modules/roles/roles.defaults.js';
import { db, pool } from '@/config/database.js';
import { permissions, rolePermissions, roles } from '@/database/schema/index.js';

const groups = process.argv.slice(2);
if (groups.length === 0) throw new Error('Pass at least one permission group, e.g. tasks activities');

let granted = 0;
for (const { name, keys } of defaultRoles.filter((r) => r.name !== 'Administrator')) {
  const wanted = keys.filter((key) => groups.includes(key.split('.')[0]!));
  if (wanted.length === 0) continue;
  const permissionRows = await db.select({ id: permissions.id }).from(permissions).where(inArray(permissions.key, wanted));
  const roleRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, name), eq(roles.isSystem, false)));
  for (const role of roleRows) {
    const inserted = await db
      .insert(rolePermissions)
      .values(permissionRows.map((p) => ({ roleId: role.id, permissionId: p.id })))
      .onConflictDoNothing()
      .returning();
    granted += inserted.length;
  }
}
console.log(`Granted ${granted} permission(s) to existing default roles`);
await pool.end();
