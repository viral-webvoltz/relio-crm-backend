import { z } from 'zod';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { ticketPriorities } from './tickets.sla.js';

export const ticketStatuses = ['open', 'pending', 'resolved', 'closed'] as const;

const body = z.string().trim().min(1).max(10_000);

export const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body,
  priority: z.enum(ticketPriorities).default('medium'),
  contactId: z.uuid().nullish(),
  assignedTo: z.uuid().nullish(),
});

// No defaults: partial updates must only change what was sent.
export const updateTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  status: z.enum(ticketStatuses).optional(),
  priority: z.enum(ticketPriorities).optional(),
  assignedTo: z.uuid().nullish(),
});

export const addMessageSchema = z.object({ body, isInternal: z.boolean().default(false) });

export const ticketListQuerySchema = listQuerySchema.extend({
  status: z.enum([...ticketStatuses, 'active']).optional(), // "active" = open + pending
  priority: z.enum(ticketPriorities).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]).optional(),
  sla: z.literal('breached').optional(),
});

// What a customer may send from the portal: no priority, assignee or internal flag.
export const portalCreateTicketSchema = z.object({ subject: z.string().trim().min(1).max(200), body });
export const portalReplySchema = z.object({ body });

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type AddMessageInput = z.infer<typeof addMessageSchema>;
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
export type PortalCreateTicketInput = z.infer<typeof portalCreateTicketSchema>;
export type PortalReplyInput = z.infer<typeof portalReplySchema>;
