import { withTransaction } from '@/config/database.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { notify } from '@/modules/notifications/notifier.js';
import { mailService } from '@/modules/mail/mail.service.js';
import { supportRepository } from './support.repository.js';
import { assignmentService } from '@/modules/assignment/assignment.service.js';
import { slaService } from './sla.service.js';
import type { TicketPriority } from './tickets.sla.js';
import type { AddMessageInput, CreateTicketInput, TicketListQuery, UpdateTicketInput } from './support.validation.js';

const fullName = (c: { firstName: string; lastName: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(' ');

class DuplicateInbound extends Error {}

class SupportService {
  private async assertAssignee(organizationId: string, assignedTo?: string | null) {
    if (!assignedTo) return;
    if (!(await supportRepository.findActiveUserId(organizationId, assignedTo))) throw new BadRequestError('Assignee not found', 'INVALID_ASSIGNEE');
  }

  async createTicket({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateTicketInput }) {
    await this.assertAssignee(organizationId, input.assignedTo);
    const routed =
      input.assignedTo === undefined
        ? await assignmentService.safePick({
            organizationId,
            resource: 'tickets',
            values: { subject: input.subject, priority: input.priority, source: 'staff' },
          })
        : null;
    const ticket = await withTransaction(async (tx) => {
      let customerName: string | null = null;
      if (input.contactId) {
        const contact = await supportRepository.findContactName(organizationId, input.contactId, tx);
        if (!contact) throw new BadRequestError('Contact not found', 'INVALID_CONTACT');
        customerName = fullName(contact);
      }
      const ticketNumber = await supportRepository.nextTicketNumber(organizationId, tx);
      const ticket = await supportRepository.insertTicket(
        {
          organizationId,
          ticketNumber,
          subject: input.subject,
          priority: input.priority,
          contactId: input.contactId,
          customerName,
          source: 'staff',
          assignedTo: input.assignedTo ?? routed?.userId,
          ...(await slaService.dueFor(organizationId, input.priority, new Date(), tx)),
          createdBy: userId,
        },
        tx,
      );
      await supportRepository.insertMessage({ organizationId, ticketId: ticket.id, authorType: 'staff', authorUserId: userId, body: input.body }, tx);
      return ticket;
    });
    await this.notifyAssigned(ticket, userId);
    return ticket;
  }

  private notifyAssigned(ticket: { id: string; organizationId: string; ticketNumber: number; subject: string; assignedTo: string | null }, actorId?: string) {
    return notify({
      organizationId: ticket.organizationId,
      userId: ticket.assignedTo,
      actorId,
      type: 'ticket_assigned',
      title: `Ticket #${ticket.ticketNumber} assigned to you`,
      body: ticket.subject,
      link: `/support/${ticket.id}`,
      relatedType: 'ticket',
      relatedId: ticket.id,
    });
  }

  async listTickets({ organizationId, userId, query }: { organizationId: string; userId: string; query: TicketListQuery }) {
    const { rows, total } = await supportRepository.list(organizationId, userId, query);
    const policy = await slaService.getPolicy(organizationId);
    return {
      rows: rows.map((r) => ({ ...r.ticket, assigneeName: r.assigneeName, isSlaBreached: r.isSlaBreached, sla: slaService.describe(r.ticket, policy) })),
      total,
    };
  }

  async getTicket(organizationId: string, id: string) {
    const row = await supportRepository.findDetail(organizationId, id);
    if (!row) throw new NotFoundError('Ticket not found');
    const messages = await supportRepository.listMessagesWithAuthors(id);

    return {
      ...row.ticket,
      assigneeName: row.assigneeName,
      isSlaBreached: row.isSlaBreached,
      sla: slaService.describe(row.ticket, await slaService.getPolicy(organizationId)),
      messages: messages.map(({ message, staffName, customerFirst, customerLast }) => ({
        ...message,
        authorName:
          message.authorType === 'staff' ? staffName : customerFirst ? fullName({ firstName: customerFirst, lastName: customerLast }) : row.ticket.customerName,
      })),
    };
  }

  async addMessage({ organizationId, userId, id, input }: { organizationId: string; userId: string; id: string; input: AddMessageInput }) {
    const { message, ticket } = await withTransaction(async (tx) => {
      const ticket = await supportRepository.lockTicket(organizationId, id, tx);
      if (!ticket) throw new NotFoundError('Ticket not found');
      // A closed ticket is a finished conversation: staff can still leave internal notes, but a customer-visible
      // reply would go nowhere, so reopen it first.
      if (ticket.status === 'closed' && !input.isInternal) throw new ConflictError('Reopen the ticket before replying to the customer', 'TICKET_CLOSED');

      const message = await supportRepository.insertMessage(
        { organizationId, ticketId: id, authorType: 'staff', authorUserId: userId, body: input.body, isInternal: input.isInternal },
        tx,
      );
      // The first customer-visible staff reply is what the first-response target measures.
      const answersFirst = !input.isInternal && !ticket.firstRespondedAt;
      await supportRepository.updateTicket(id, { updatedAt: new Date(), ...(answersFirst && { firstRespondedAt: new Date() }) }, tx);
      return { message, ticket };
    });
    // Internal notes are staff chatter, not a reply.
    if (!input.isInternal) {
      await notify({
        organizationId,
        userId: ticket.assignedTo,
        actorId: userId,
        type: 'ticket_replied',
        title: `New reply on ticket #${ticket.ticketNumber}`,
        body: ticket.subject,
        link: `/support/${ticket.id}`,
        relatedType: 'ticket',
        relatedId: ticket.id,
      });
      await mailService.queueTicketReply({ organizationId, ticket, body: input.body });
    }
    return message;
  }

  async updateTicket({ organizationId, id, input, actorId }: { organizationId: string; id: string; input: UpdateTicketInput; actorId?: string }) {
    let previousAssignee: string | null = null;
    const updated = await withTransaction(async (tx) => {
      if (input.assignedTo) await this.assertAssignee(organizationId, input.assignedTo);
      const current = await supportRepository.lockTicket(organizationId, id, tx);
      if (!current) throw new NotFoundError('Ticket not found');
      previousAssignee = current.assignedTo;

      const status = input.status ?? current.status;
      const priority = (input.priority ?? current.priority) as TicketPriority;
      const isFinished = status === 'resolved' || status === 'closed';
      const due = await slaService.dueFor(organizationId, priority, current.createdAt, tx);
      const deadlineMoved = due.slaDueAt.getTime() !== current.slaDueAt.getTime();
      return supportRepository.updateTicket(
        id,
        {
          ...(input.subject !== undefined && { subject: input.subject }),
          status,
          priority,
          ...(input.assignedTo !== undefined && { assignedTo: input.assignedTo }),
          // The deadlines always follow priority and the policy; they are measured from creation, not from the change.
          // A ticket that predates first-response tracking keeps having no first-reply target.
          slaDueAt: due.slaDueAt,
          ...(current.firstResponseDueAt && { firstResponseDueAt: due.firstResponseDueAt }),
          // A moved deadline can raise its alerts again.
          ...(deadlineMoved && { slaWarnedAt: null, slaBreachNotifiedAt: null, firstResponseBreachNotifiedAt: null }),
          // Stamp when it was first finished; clear it if the ticket is reopened.
          resolvedAt: isFinished ? (current.resolvedAt ?? new Date()) : null,
          updatedAt: new Date(),
        },
        tx,
      );
    });
    if (input.assignedTo && input.assignedTo !== previousAssignee) await this.notifyAssigned(updated, actorId);
    return updated;
  }

  // ---- Inbound email (see modules/inbound-email) ----

  // New ticket from a known contact's email. Returns undefined when this Message-ID was already processed.
  async createTicketFromEmail({
    organizationId,
    contactId,
    subject,
    body,
    emailMessageId,
  }: {
    organizationId: string;
    contactId: string;
    subject: string;
    body: string;
    emailMessageId: string;
  }) {
    if (await supportRepository.messageIdExists(organizationId, emailMessageId)) return undefined;
    const routed = await assignmentService.safePick({
      organizationId,
      resource: 'tickets',
      values: { subject: subject || '(no subject)', priority: 'medium', source: 'email' },
    });
    try {
      const ticket = await withTransaction(async (tx) => {
        const contact = await supportRepository.findContactName(organizationId, contactId, tx);
        if (!contact) throw new BadRequestError('Contact not found', 'INVALID_CONTACT');
        const ticket = await supportRepository.insertTicket(
          {
            organizationId,
            ticketNumber: await supportRepository.nextTicketNumber(organizationId, tx),
            subject: subject || '(no subject)',
            priority: 'medium',
            contactId,
            customerName: fullName(contact),
            source: 'email',
            assignedTo: routed?.userId,
            ...(await slaService.dueFor(organizationId, 'medium', new Date(), tx)),
          },
          tx,
        );
        const message = await supportRepository.insertInboundMessage(
          { organizationId, ticketId: ticket.id, authorType: 'customer', authorContactId: contactId, body, emailMessageId },
          tx,
        );
        if (!message) throw new DuplicateInbound(); // lost a race with a parallel delivery: roll the ticket back
        return ticket;
      });
      if (ticket.assignedTo) await this.notifyAssigned(ticket);
      await mailService.queueTicketReceived({ organizationId, ticket });
      return ticket;
    } catch (err) {
      if (err instanceof DuplicateInbound) return undefined;
      throw err;
    }
  }

  // Customer reply by email; reopens the ticket like a portal reply. Returns undefined on redelivery.
  async addCustomerEmailReply({
    ticketId,
    organizationId,
    contactId,
    body,
    emailMessageId,
  }: {
    ticketId: string;
    organizationId: string;
    contactId: string;
    body: string;
    emailMessageId: string;
  }) {
    try {
      const ticket = await withTransaction(async (tx) => {
        const ticket = await supportRepository.lockTicket(organizationId, ticketId, tx);
        if (!ticket) throw new NotFoundError('Ticket not found');
        const message = await supportRepository.insertInboundMessage(
          { organizationId, ticketId, authorType: 'customer', authorContactId: contactId, body, emailMessageId },
          tx,
        );
        if (!message) throw new DuplicateInbound();
        await supportRepository.updateTicket(ticketId, { status: 'open', resolvedAt: null, updatedAt: new Date() }, tx);
        return ticket;
      });
      await notify({
        organizationId,
        userId: ticket.assignedTo,
        type: 'ticket_replied',
        title: `Customer replied on ticket #${ticket.ticketNumber}`,
        body: ticket.subject,
        link: `/support/${ticket.id}`,
        relatedType: 'ticket',
        relatedId: ticket.id,
      });
      return ticket;
    } catch (err) {
      if (err instanceof DuplicateInbound) return undefined;
      throw err;
    }
  }
}

export const supportService = new SupportService();
