import { and, eq, isNull } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from '@/config/database.js';
import { companies, contacts, deals, invoices, leads, orders, quotes, supportTickets, type DocumentEntityType } from '@/database/schema/index.js';
import type { PermissionKey } from '@/shared/constants/permissions.js';

type Rule = { permission: PermissionKey; table: PgTable; id: AnyPgColumn; organizationId: AnyPgColumn; deletedAt?: AnyPgColumn };

const rule = (permission: PermissionKey, table: PgTable & { id: AnyPgColumn; organizationId: AnyPgColumn }, deletedAt?: AnyPgColumn): Rule => ({
  permission,
  table,
  id: table.id,
  organizationId: table.organizationId,
  ...(deletedAt && { deletedAt }),
});

// What a file can be attached to, and the permission that lets a person see that record. Seeing a file needs the same right as seeing the
// record it belongs to, so documents cannot be used to read around a role's limits.
const rules: Record<DocumentEntityType, Rule> = {
  contact: rule('contacts.view', contacts, contacts.deletedAt),
  company: rule('companies.view', companies, companies.deletedAt),
  lead: rule('leads.view', leads, leads.deletedAt),
  deal: rule('deals.view', deals, deals.deletedAt),
  ticket: rule('tickets.view', supportTickets),
  quote: rule('quotes.view', quotes),
  order: rule('orders.view', orders),
  invoice: rule('invoices.view', invoices),
};

export const viewPermission = (type: DocumentEntityType): PermissionKey => rules[type].permission;

export async function entityExists(organizationId: string, type: DocumentEntityType, recordId: string): Promise<boolean> {
  const { table, id, organizationId: orgColumn, deletedAt } = rules[type];
  const [row] = await db
    .select({ id })
    .from(table)
    .where(and(eq(orgColumn, organizationId), eq(id, recordId), deletedAt ? isNull(deletedAt) : undefined))
    .limit(1);
  return Boolean(row);
}
