import { z } from 'zod';
import { companies, contacts, deals, leads, supportTickets, tasks } from '@/database/schema/index.js';
import { leadPriorities, leadSources, leadStatuses } from '@/modules/leads/leads.validation.js';
import { ticketPriorities } from '@/modules/support/tickets.sla.js';

const date = z.iso.date();
const text = (max: number) => z.string().max(max);
const uuid = z.uuid();

// What an "update record" step may change, per resource (the first segment of the trigger event). Never ids, organization,
// stage/pipeline, status flows with side effects (task completion, ticket resolution) or anything permission related.
// Values arrive as strings; the schema decides whether the value is acceptable for that field.
export const editable = {
  leads: {
    table: leads,
    fields: {
      status: z.enum(leadStatuses),
      priority: z.enum(leadPriorities),
      source: z.enum(leadSources),
      assignedTo: uuid,
      followUpDate: date,
      notes: text(5000),
    },
  },
  deals: { table: deals, fields: { ownerId: uuid, lostReason: text(500), expectedCloseDate: date } },
  contacts: { table: contacts, fields: { jobTitle: text(200), phone: text(50), notes: text(5000) } },
  companies: { table: companies, fields: { industry: text(200), phone: text(50), website: text(500), notes: text(5000) } },
  tasks: { table: tasks, fields: { priority: z.enum(['low', 'medium', 'high']), assignedTo: uuid, description: text(5000) } },
  tickets: { table: supportTickets, fields: { priority: z.enum(ticketPriorities), assignedTo: uuid } },
} as const;

export type EditableResource = keyof typeof editable;
export const isEditableResource = (resource: string | undefined): resource is EditableResource => resource !== undefined && resource in editable;

const userFields = new Set(['assignedTo', 'ownerId']);
export const isUserField = (field: string) => userFields.has(field);

// null when the value is fine for the field, otherwise a message.
// `rendered`: the value is final (placeholders already substituted), so text that merely looks like a template is just text and gets checked.
export function fieldProblem(resource: string | undefined, field: string, value: string, { rendered = false } = {}): string | null {
  if (!isEditableResource(resource)) return `Update record is not available for ${resource ?? 'this trigger'}`;
  const schemas: Record<string, z.ZodType> = editable[resource].fields;
  const schema = schemas[field];
  if (!schema) return `"${field}" cannot be changed by a workflow on ${resource}`;
  // Templates ({{field}}) are only resolved at run time, so only the plain form is checked here.
  if (!rendered && /\{\{.*\}\}/.test(value)) return null;
  return schema.safeParse(value).success ? null : `"${value}" is not a valid value for ${field}`;
}
