import type { ZodType } from 'zod';
import type { PermissionKey } from '@/shared/constants/permissions.js';
import { companiesService } from '@/modules/companies/companies.service.js';
import { createCompanySchema } from '@/modules/companies/companies.validation.js';
import { contactsService } from '@/modules/contacts/contacts.service.js';
import { createContactSchema } from '@/modules/contacts/contacts.validation.js';
import { leadsService } from '@/modules/leads/leads.service.js';
import { createLeadSchema } from '@/modules/leads/leads.validation.js';
import { productsService } from '@/modules/products/products.service.js';
import { createProductSchema } from '@/modules/products/products.validation.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import { createTaskSchema } from '@/modules/tasks/tasks.validation.js';

export const importResourceNames = ['leads', 'contacts', 'companies', 'products', 'tasks'] as const;
export type ImportResourceName = (typeof importResourceNames)[number];

export interface ImportContext {
  organizationId: string;
  userId: string;
  canAssign: boolean;
}

export interface ImportResource {
  permission: PermissionKey;
  fields: readonly string[];
  // CSV cells are text: numbers and booleans are converted here, everything else is left to the create schema.
  toRecord(cells: Readonly<Record<string, string>>): Record<string, unknown>;
  // Runs the create schema only; returns the parsed input or the zod error.
  validate(record: Record<string, unknown>): { success: true } | { success: false; error: Error };
  // Parses with the create schema, then calls the resource service `create` so every business rule applies.
  create(context: ImportContext, record: Record<string, unknown>): Promise<unknown>;
}

const booleanWords = new Map([
  ['true', true],
  ['yes', true],
  ['1', true],
  ['false', false],
  ['no', false],
  ['0', false],
]);

function defineImport<I>(config: {
  permission: PermissionKey;
  schema: ZodType<I>;
  fields: readonly string[];
  numbers?: readonly string[];
  booleans?: readonly string[];
  create: (context: ImportContext, input: I) => Promise<unknown>;
}): ImportResource {
  return {
    permission: config.permission,
    fields: config.fields,
    toRecord(cells) {
      const record: Record<string, unknown> = {};
      for (const [field, text] of Object.entries(cells)) {
        if (text === '') continue; // an empty cell means "not provided", so schema defaults apply
        if (config.numbers?.includes(field)) record[field] = Number.isFinite(Number(text)) ? Number(text) : text;
        else if (config.booleans?.includes(field)) record[field] = booleanWords.get(text.toLowerCase()) ?? text;
        else record[field] = text;
      }
      return record;
    },
    validate(record) {
      const parsed = config.schema.safeParse(record);
      return parsed.success ? { success: true } : { success: false, error: parsed.error };
    },
    create: (context, record) => config.create(context, config.schema.parse(record)),
  };
}

export const importResources = {
  leads: defineImport({
    permission: 'leads.create',
    schema: createLeadSchema,
    fields: ['firstName', 'lastName', 'email', 'phone', 'companyName', 'source', 'status', 'priority', 'score', 'assignedTo', 'followUpDate', 'notes'],
    numbers: ['score'],
    create: ({ organizationId, canAssign }, input) => leadsService.create({ organizationId, input, canAssign }),
  }),
  contacts: defineImport({
    permission: 'contacts.create',
    schema: createContactSchema,
    fields: ['firstName', 'lastName', 'email', 'phone', 'jobTitle', 'notes', 'companyId'],
    create: ({ organizationId }, input) => contactsService.create({ organizationId, input }),
  }),
  companies: defineImport({
    permission: 'companies.create',
    schema: createCompanySchema,
    fields: ['name', 'website', 'industry', 'phone', 'notes'],
    create: ({ organizationId }, input) => companiesService.create({ organizationId, input }),
  }),
  products: defineImport({
    permission: 'products.create',
    schema: createProductSchema,
    fields: ['name', 'sku', 'description', 'categoryId', 'priceMinor', 'currency', 'trackInventory', 'reorderLevel', 'isActive', 'initialStock'],
    numbers: ['priceMinor', 'reorderLevel', 'initialStock'],
    booleans: ['trackInventory', 'isActive'],
    create: ({ organizationId, userId }, input) => productsService.create({ organizationId, userId, input }),
  }),
  tasks: defineImport({
    permission: 'tasks.create',
    schema: createTaskSchema,
    fields: ['title', 'description', 'dueDate', 'priority', 'recurrence', 'assignedTo', 'relatedType', 'relatedId'],
    create: ({ organizationId, userId }, input) => tasksService.createTask({ organizationId, userId, input }),
  }),
} satisfies Record<ImportResourceName, ImportResource>;
