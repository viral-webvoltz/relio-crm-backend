import type { DbExecutor } from '@/config/database.js';
import { permissionKeys, type PermissionKey } from '@/shared/constants/permissions.js';
import { rolesRepository } from './roles.repository.js';

export const ownerRoleName = 'Organization Owner';
export const administratorRoleName = 'Administrator';

const viewKeys = permissionKeys.filter((k) => k.endsWith('.view'));
const crud = (prefix: string) => permissionKeys.filter((k) => k.startsWith(`${prefix}.`));

export const defaultRoles: { name: string; keys: readonly PermissionKey[] }[] = [
  { name: administratorRoleName, keys: permissionKeys },
  {
    name: 'Sales Manager',
    keys: [
      ...crud('contacts'),
      ...crud('companies'),
      ...crud('leads'),
      ...crud('deals'),
      ...crud('tasks'),
      ...crud('activities'),
      ...crud('products'),
      'orders.view',
      'orders.create',
      'orders.update',
      ...crud('invoices'),
      ...crud('payments'),
      ...crud('quotes'),
      ...crud('campaigns'),
      ...crud('subscriptions'),
      ...crud('goals'),
      ...crud('documents'),
      ...crud('tickets'),
      'portal.manage',
    ],
  },
  {
    name: 'Support Agent',
    keys: [
      'contacts.view',
      'orders.view',
      'invoices.view',
      'products.view',
      'activities.view',
      'activities.create',
      'documents.view',
      'documents.create',
      ...crud('tickets'),
    ],
  },
  {
    name: 'Sales Representative',
    keys: [
      'contacts.view',
      'contacts.create',
      'contacts.update',
      'companies.view',
      'companies.create',
      'companies.update',
      'leads.view',
      'leads.create',
      'leads.update',
      'leads.convert',
      'deals.view',
      'deals.create',
      'deals.update',
      'tasks.view',
      'tasks.create',
      'tasks.update',
      'activities.view',
      'activities.create',
      'activities.update',
      'products.view',
      'orders.view',
      'orders.create',
      'invoices.view',
      'quotes.view',
      'quotes.create',
      'quotes.update',
      'goals.view',
      'documents.view',
      'documents.create',
      'tickets.view',
      'tickets.create',
      'tickets.reply',
    ],
  },
  { name: 'Viewer', keys: viewKeys },
];

export async function ensureOwnerRole(tx: DbExecutor, organizationId: string) {
  const existing = await rolesRepository.findByName({ organizationId, name: ownerRoleName }, tx);
  if (existing) return existing;
  return rolesRepository.create({ organizationId, name: ownerRoleName, isSystem: true }, tx);
}

// Creates any default role the org is missing; existing (possibly edited) roles are left alone.
export async function ensureDefaultRoles(tx: DbExecutor, organizationId: string) {
  for (const { name, keys } of defaultRoles) {
    const created = await rolesRepository.createIfMissing({ organizationId, name }, tx);
    if (!created) continue;
    const ids = await rolesRepository.findPermissionIds({ keys }, tx);
    await rolesRepository.insertRolePermissions({ roleId: created.id, permissionIds: ids.map((p) => p.id) }, tx);
  }
}
