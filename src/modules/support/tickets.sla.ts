export const ticketPriorities = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof ticketPriorities)[number];

// Target time to resolve a ticket, by priority.
export const slaHours: Record<TicketPriority, number> = { urgent: 4, high: 24, medium: 72, low: 120 };

export const slaDueAt = (createdAt: Date, priority: TicketPriority) => new Date(createdAt.getTime() + slaHours[priority] * 3_600_000);

// The clock only runs while the ball is in our court: a ticket waiting on the customer, or already
// resolved or closed, cannot breach its SLA.
export const isSlaBreached = (ticket: { status: string; slaDueAt: Date }, now = new Date()) => ticket.status === 'open' && ticket.slaDueAt < now;
