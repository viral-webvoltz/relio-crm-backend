import type { ZodType } from 'zod';
import type { PermissionKey } from '@/shared/constants/permissions.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { companiesService } from '@/modules/companies/companies.service.js';
import { contactsService } from '@/modules/contacts/contacts.service.js';
import { invoicesService } from '@/modules/invoices/invoices.service.js';
import { invoiceListQuerySchema } from '@/modules/invoices/invoices.validation.js';
import { leadsService } from '@/modules/leads/leads.service.js';
import { leadListQuerySchema } from '@/modules/leads/leads.validation.js';
import { ordersService } from '@/modules/orders/orders.service.js';
import { orderListQuerySchema } from '@/modules/orders/orders.validation.js';
import { productsService } from '@/modules/products/products.service.js';
import { productListQuerySchema } from '@/modules/products/products.validation.js';
import { salesService } from '@/modules/sales/sales.service.js';
import { dealListQuerySchema } from '@/modules/sales/sales.validation.js';
import { supportService } from '@/modules/support/support.service.js';
import { ticketListQuerySchema } from '@/modules/support/support.validation.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import { taskListQuerySchema } from '@/modules/tasks/tasks.validation.js';

export const EXPORT_PAGE_SIZE = 100;

export interface ExportResource {
  permission: PermissionKey;
  headers: readonly string[];
  // Validates a raw query with the resource's own list schema and returns the normalised form (safe to store in a job).
  parseQuery(raw: unknown): Record<string, unknown>;
  // One page of the resource's own list, projected onto the whitelisted columns.
  fetchPage(args: { organizationId: string; userId: string; query: Record<string, unknown>; page: number }): Promise<{ total: number; rows: unknown[][] }>;
}

// Reuses each resource's list method, so filters, sorting and tenant scoping stay in one place (the repositories).
function defineExport<Q extends ListQuery, R extends object>(config: {
  permission: PermissionKey;
  schema: ZodType<Q>;
  columns: readonly (keyof R & string)[];
  list: (args: { organizationId: string; userId: string; query: Q }) => Promise<{ rows: R[]; total: number }>;
}): ExportResource {
  return {
    permission: config.permission,
    headers: config.columns,
    parseQuery: (raw) => ({ ...config.schema.parse(raw) }),
    async fetchPage({ organizationId, userId, query, page }) {
      const parsed = config.schema.parse({ ...query, page, limit: EXPORT_PAGE_SIZE });
      const { rows, total } = await config.list({ organizationId, userId, query: parsed });
      return { total, rows: rows.map((row) => config.columns.map((column) => row[column])) };
    },
  };
}

export const exportResourceNames = ['leads', 'contacts', 'companies', 'deals', 'tasks', 'orders', 'products', 'invoices', 'tickets'] as const;
export type ExportResourceName = (typeof exportResourceNames)[number];

export const exportResources = {
  leads: defineExport({
    permission: 'leads.view',
    schema: leadListQuerySchema,
    columns: [
      'firstName',
      'lastName',
      'email',
      'phone',
      'companyName',
      'source',
      'status',
      'priority',
      'score',
      'assignedTo',
      'followUpDate',
      'notes',
      'createdAt',
    ],
    list: ({ organizationId, query }) => leadsService.list({ organizationId, query }),
  }),
  contacts: defineExport({
    permission: 'contacts.view',
    schema: listQuerySchema,
    columns: ['firstName', 'lastName', 'email', 'phone', 'jobTitle', 'companyName', 'notes', 'createdAt'],
    list: ({ organizationId, query }) => contactsService.list({ organizationId, query }),
  }),
  companies: defineExport({
    permission: 'companies.view',
    schema: listQuerySchema,
    columns: ['name', 'website', 'industry', 'phone', 'notes', 'createdAt'],
    list: ({ organizationId, query }) => companiesService.list({ organizationId, query }),
  }),
  deals: defineExport({
    permission: 'deals.view',
    schema: dealListQuerySchema,
    columns: ['title', 'valueMinor', 'currency', 'expectedCloseDate', 'stageId', 'contactId', 'companyId', 'ownerId', 'createdAt'],
    list: ({ organizationId, query }) => salesService.listDeals({ organizationId, query }),
  }),
  tasks: defineExport({
    permission: 'tasks.view',
    schema: taskListQuerySchema,
    columns: ['title', 'description', 'dueDate', 'priority', 'status', 'recurrence', 'assigneeName', 'createdAt'],
    list: ({ organizationId, userId, query }) => tasksService.listTasks({ organizationId, userId, query }),
  }),
  orders: defineExport({
    permission: 'orders.view',
    schema: orderListQuerySchema,
    columns: ['orderNumber', 'status', 'customerName', 'currency', 'subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor', 'notes', 'createdAt'],
    list: ({ organizationId, query }) => ordersService.list({ organizationId, query }),
  }),
  products: defineExport({
    permission: 'products.view',
    schema: productListQuerySchema,
    columns: ['name', 'sku', 'description', 'priceMinor', 'currency', 'trackInventory', 'stockQuantity', 'reorderLevel', 'isActive', 'createdAt'],
    list: ({ organizationId, query }) => productsService.list({ organizationId, query }),
  }),
  invoices: defineExport({
    permission: 'invoices.view',
    schema: invoiceListQuerySchema,
    columns: ['invoiceNumber', 'orderNumber', 'status', 'customerName', 'currency', 'totalMinor', 'paidMinor', 'issueDate', 'dueDate', 'createdAt'],
    list: ({ organizationId, query }) => invoicesService.list({ organizationId, query }),
  }),
  tickets: defineExport({
    permission: 'tickets.view',
    schema: ticketListQuerySchema,
    columns: [
      'ticketNumber',
      'subject',
      'status',
      'priority',
      'customerName',
      'assigneeName',
      'source',
      'slaDueAt',
      'isSlaBreached',
      'resolvedAt',
      'createdAt',
    ],
    list: ({ organizationId, userId, query }) => supportService.listTickets({ organizationId, userId, query }),
  }),
} satisfies Record<ExportResourceName, ExportResource>;
