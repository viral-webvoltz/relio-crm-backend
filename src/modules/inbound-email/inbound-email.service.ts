import { supportService } from '@/modules/support/support.service.js';
import { supportRepository } from '@/modules/support/support.repository.js';
import { recordEmailsService } from '@/modules/record-emails/record-emails.service.js';
import { extractAddress, extractReplyToken, isAutomated, stripQuotedReply, type InboundEmail } from './inbound-email.parse.js';

export type InboundResult = { status: 200 | 201 | 202; body: Record<string, unknown> };
const ignored = (reason: string): InboundResult => ({ status: 202, body: { ignored: reason } });
const duplicate: InboundResult = { status: 200, body: { duplicate: true } };

class InboundEmailService {
  async process(email: InboundEmail): Promise<InboundResult> {
    if (isAutomated(email.from, email.headers)) return ignored('automated');
    const sender = extractAddress(email.from);
    if (!sender) return ignored('invalid_sender');
    const body = stripQuotedReply(email.text);
    if (!body) return ignored('empty_body');

    // (a) plus-address token, then (b) In-Reply-To / References.
    const token = email.to.map(extractReplyToken).find(Boolean);
    let ticket = token ? await supportRepository.findTicketByReplyToken(token) : undefined;
    ticket ??= await supportRepository.findTicketByMessageIds([...(email.inReplyTo ? [email.inReplyTo] : []), ...email.references]);

    // Not a ticket: it may be a lead or contact answering an email sent from the CRM (matched by token, then by In-Reply-To).
    if (!ticket) {
      const replied = await recordEmailsService.recordReply({
        organizationId: email.organizationId,
        threadId: email.threadId,
        token,
        messageIds: [...(email.inReplyTo ? [email.inReplyTo] : []), ...email.references],
        sender,
        subject: email.subject,
        body,
        messageId: email.messageId,
      });
      if (replied) return replied;
    }

    // A closed ticket is finished: a reply starts a new one instead of vanishing.
    if (ticket && ticket.status !== 'closed') {
      const contactEmail = ticket.contactId ? await supportRepository.findContactEmail(ticket.organizationId, ticket.contactId) : undefined;
      if (!ticket.contactId || contactEmail?.toLowerCase() !== sender) return ignored('sender_mismatch');
      const added = await supportService.addCustomerEmailReply({
        ticketId: ticket.id,
        organizationId: ticket.organizationId,
        contactId: ticket.contactId,
        body,
        emailMessageId: email.messageId,
      });
      return added ? { status: 201, body: { ticketId: ticket.id } } : duplicate;
    }

    // (c) new ticket for a known contact. Ambiguous across organizations = ignored unless the caller named the organization.
    const contacts = await supportRepository.findContactsByEmail(sender, ticket?.organizationId ?? email.organizationId);
    const contact = contacts[0];
    if (!contact) return ignored('unknown_sender');
    if (contacts.length > 1) return ignored('ambiguous_sender');
    const created = await supportService.createTicketFromEmail({
      organizationId: contact.organizationId,
      contactId: contact.id,
      subject: email.subject.slice(0, 200),
      body,
      emailMessageId: email.messageId,
    });
    return created ? { status: 201, body: { ticketId: created.id } } : duplicate;
  }
}

export const inboundEmailService = new InboundEmailService();
