import { withTransaction } from '@/config/database.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { AuthCustomer } from '@/modules/portal/portal.auth.js';
import { assignmentService } from '@/modules/assignment/assignment.service.js';
import { notify } from '@/modules/notifications/notifier.js';
import { supportRepository } from './support.repository.js';
import { slaService } from './sla.service.js';

// Customer-facing ticket access. Scoped by the contact id from the server-side session.
type Scope = Pick<AuthCustomer, 'organizationId' | 'contactId'>;

const MAX_OPEN_TICKETS_PER_CUSTOMER = 20;

class SupportPortalService {
  listTickets(customer: Scope, query: ListQuery) {
    return supportRepository.listOwn(customer, query);
  }

  async getTicket(customer: Scope, id: string) {
    const ticket = await supportRepository.findOwn(customer, id);
    if (!ticket) throw new NotFoundError('Ticket not found');
    return { ...ticket, messages: await supportRepository.listPublicMessages(id) };
  }

  async createTicket(customer: AuthCustomer, input: { subject: string; body: string }) {
    const routed = await assignmentService.safePick({
      organizationId: customer.organizationId,
      resource: 'tickets',
      values: { subject: input.subject, priority: 'medium', source: 'portal' },
    });
    const ticket = await withTransaction(async (tx) => {
      // A cap on open tickets keeps one account from flooding the support queue.
      if ((await supportRepository.countOwnOpen(customer, tx)) >= MAX_OPEN_TICKETS_PER_CUSTOMER) {
        throw new ConflictError('You have a lot of open tickets already. Please wait for a reply or add to an existing one.', 'TOO_MANY_OPEN_TICKETS');
      }

      const contact = await supportRepository.findContactName(customer.organizationId, customer.contactId, tx);
      const customerName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ');
      const ticketNumber = await supportRepository.nextTicketNumber(customer.organizationId, tx);
      const ticket = await supportRepository.insertPortalTicket(
        {
          organizationId: customer.organizationId,
          ticketNumber,
          subject: input.subject,
          priority: 'medium',
          contactId: customer.contactId,
          customerName,
          source: 'portal',
          assignedTo: routed?.userId,
          ...(await slaService.dueFor(customer.organizationId, 'medium', new Date(), tx)),
        },
        tx,
      );
      await supportRepository.insertMessage(
        { organizationId: customer.organizationId, ticketId: ticket.id, authorType: 'customer', authorContactId: customer.contactId, body: input.body },
        tx,
      );
      return ticket;
    });
    // The customer never sees who it was routed to (the portal view has no assignee), but the assignee hears about it.
    if (routed) await assignmentService.tell(customer.organizationId, 'tickets', ticket.id, routed.userId, input.subject);
    return ticket;
  }

  // A customer reply puts the ticket back in the staff queue, even if it had been resolved.
  async addReply({ customer, id, body }: { customer: AuthCustomer; id: string; body: string }) {
    const { message, ticket } = await withTransaction(async (tx) => {
      const ticket = await supportRepository.lockOwnTicket(customer, id, tx);
      if (!ticket) throw new NotFoundError('Ticket not found');
      if (ticket.status === 'closed') throw new ConflictError('This ticket is closed. Please open a new one.', 'TICKET_CLOSED');

      const message = await supportRepository.insertMessage(
        { organizationId: customer.organizationId, ticketId: id, authorType: 'customer', authorContactId: customer.contactId, body },
        tx,
      );
      await supportRepository.updateTicket(id, { status: 'open', resolvedAt: null, updatedAt: new Date() }, tx);
      return { message, ticket };
    });
    await notify({
      organizationId: customer.organizationId,
      userId: ticket.assignedTo,
      type: 'ticket_replied',
      title: `Customer replied on ticket #${ticket.ticketNumber}`,
      body: ticket.subject,
      link: `/support/${ticket.id}`,
      relatedType: 'ticket',
      relatedId: ticket.id,
    });
    return { id: message.id, authorType: message.authorType, body: message.body, createdAt: message.createdAt };
  }
}

export const supportPortalService = new SupportPortalService();
