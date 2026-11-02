import { randomUUID } from 'node:crypto';
import { env } from '@/config/env.js';
import { AppError, BadRequestError, NotFoundError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/logger.js';
import { notify } from '@/modules/notifications/notifier.js';
import { enqueueWebhookEvent } from '@/modules/webhooks/webhooks.dispatcher.js';
import { enqueueWorkflowEvent } from '@/modules/workflows/workflows.events.js';
import { canSendMail, queueEmail } from '@/modules/mail/mail.service.js';
import { mailSettings } from '@/modules/mail/mail.settings.js';
import { messageIdDomain, plusAddress } from '@/modules/mail/mail.headers.js';
import { esc } from '@/modules/mail/mail.templates.js';
import { recordEmailsRepository as repo, type EmailRecordType } from './record-emails.repository.js';
import { classifyReply, type ReplyIntent } from './record-emails.intent.js';
import { makeReplyToken, readReplyToken } from './record-emails.token.js';
import type { SendRecordEmailInput } from './record-emails.validation.js';

export type ReplyResult = { status: 200 | 201 | 202; body: Record<string, unknown> };

// Status rules. Sending the first email marks a new lead as contacted. A reply is read for intent: interested moves the lead to qualified, an
// explicit no moves it to unqualified, and anything unclear leaves the status alone and tells the assignee to read it. Converted leads are
// never touched. Custom rules belong in workflows, which get a `leads.email_reply` event carrying the intent.
const ON_SEND = { from: ['new'], to: 'contacted' };
const ON_REPLY: Record<Exclude<ReplyIntent, 'unclear'>, { from: string[]; to: string }> = {
  interested: { from: ['new', 'contacted', 'unqualified'], to: 'qualified' },
  not_interested: { from: ['new', 'contacted', 'qualified'], to: 'unqualified' },
};
const INTENT_TITLE: Record<ReplyIntent, string> = { interested: 'is interested', not_interested: 'is not interested', unclear: 'replied to your email' };

// "Re: Re: Hello" -> "Hello"
const baseSubject = (subject: string) => subject.replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '').trim();

const asHtml = (text: string) => `<div style="white-space:pre-wrap">${esc(text)}</div>`;
const plural = (type: EmailRecordType) => (type === 'lead' ? 'leads' : 'contacts');

class RecordEmailsService {
  async send({ organizationId, userId, type, id, input }: { organizationId: string; userId: string; type: EmailRecordType; id: string; input: SendRecordEmailInput }) {
    if (!(await canSendMail(organizationId))) throw new AppError('Email is not configured', 503, 'MAIL_NOT_CONFIGURED');
    const record = await repo.findRecord({ organizationId, type, id });
    if (!record) throw new NotFoundError(`${type === 'lead' ? 'Lead' : 'Contact'} not found`);
    if (!record.email) throw new BadRequestError('This record has no email address', 'NO_RECIPIENT');

    const previous = await repo.lastMessageId({ organizationId, type, id });
    const messageId = `${randomUUID()}@${messageIdDomain(env.MAIL_FROM)}`;
    const activity = await repo.insertEmail({
      organizationId,
      type: 'email',
      subject: input.subject,
      body: input.body,
      relatedType: type,
      relatedId: id,
      direction: 'outbound',
      emailAddress: record.email,
      messageId,
      createdBy: userId,
    });
    if (!activity) throw new Error('Failed to record email');

    const queued = await queueEmail({
      organizationId,
      kind: 'record_email',
      to: record.email,
      subject: input.subject,
      html: asHtml(input.body),
      text: input.body,
      relatedType: type,
      relatedId: id,
      messageId: `<${messageId}>`,
      replyTo: plusAddress(await mailSettings.inboundAddress(organizationId), makeReplyToken(activity.id)),
      inReplyTo: previous ? `<${previous}>` : undefined,
    });
    if (!queued) {
      await repo.deleteActivity(activity.id); // nothing was sent, so nothing should appear in the history
      throw new AppError('Failed to queue email', 503, 'MAIL_QUEUE_FAILED');
    }

    if (type === 'lead') await repo.advanceLead({ organizationId, id, ...ON_SEND }).catch((err: unknown) => logger.error({ err }, 'Failed to advance lead after email'));
    return activity;
  }

  list({ organizationId, type, id }: { organizationId: string; type: EmailRecordType; id: string }) {
    return repo.listEmails({ organizationId, type, id });
  }

  // Called by the inbound email handler for mail that is not a ticket reply. Returns undefined when the mail is not a reply to
  // anything sent from a lead or contact, so the caller can carry on with its other rules.
  async recordReply({
    organizationId: scopedTo,
    token,
    messageIds,
    threadId,
    sender,
    subject,
    body,
    messageId,
  }: {
    organizationId?: string; // set when the mail was read from one organization's inbox
    token?: string;
    messageIds: string[];
    threadId?: string;
    sender: string;
    subject: string;
    body: string;
    messageId: string;
  }): Promise<ReplyResult | undefined> {
    const tokenId = token ? readReplyToken(token) : undefined;
    const original =
      (tokenId ? await repo.findOutboundById(tokenId) : undefined) ??
      (messageIds.length ? await repo.findOutboundByMessageIds(messageIds) : undefined) ??
      (threadId && scopedTo ? await repo.findOutboundByThread({ organizationId: scopedTo, threadId }) : undefined) ??
      // Gmail rewrites Message-IDs, and emails sent before threads were tracked have no thread: fall back to who it came from and what it answers.
      (scopedTo && baseSubject(subject) ? await repo.findLatestOutboundTo({ organizationId: scopedTo, email: sender, subject: baseSubject(subject) }) : undefined);
    if (!original || (original.relatedType !== 'lead' && original.relatedType !== 'contact')) return undefined;

    const type: EmailRecordType = original.relatedType;
    const { organizationId, relatedId: id } = original;
    const record = await repo.findRecord({ organizationId, type, id });
    // Only the person we wrote to can reply into their own history.
    if (!record?.email || record.email.toLowerCase() !== sender) return { status: 202, body: { ignored: 'sender_mismatch' } };

    const saved = await repo.insertEmail({
      organizationId,
      type: 'email',
      subject: subject.slice(0, 200) || '(no subject)',
      body: body.slice(0, 20_000),
      relatedType: type,
      relatedId: id,
      direction: 'inbound',
      emailAddress: sender,
      messageId,
    });
    if (!saved) return { status: 200, body: { duplicate: true } };

    await this.afterReply({ organizationId, type, record, activityId: saved.id, intent: classifyReply(body) });
    return { status: 201, body: { [`${type}Id`]: id, activityId: saved.id } };
  }

  // Everything here is a consequence of the reply, never a reason to refuse it.
  private async afterReply({
    organizationId,
    type,
    record,
    activityId,
    intent,
  }: {
    organizationId: string;
    type: EmailRecordType;
    record: { id: string; name: string; email: string | null; assignedTo: string | null };
    activityId: string;
    intent: ReplyIntent;
  }) {
    try {
      const rule = intent === 'unclear' ? undefined : ON_REPLY[intent];
      const advanced = type === 'lead' && rule ? await repo.advanceLead({ organizationId, id: record.id, ...rule }) : false;
      const status = advanced && rule ? rule.to : undefined;
      const event = `${plural(type)}.email_reply`;
      void enqueueWebhookEvent({ organizationId, event, data: { id: record.id, activityId, intent, ...(status && { status }) } });
      await notify({
        organizationId,
        userId: record.assignedTo,
        type: 'email_reply',
        title: `${record.name} ${INTENT_TITLE[intent]}`,
        link: `/${plural(type)}/${record.id}`,
        relatedType: type,
        relatedId: record.id,
      });
      if (record.assignedTo) {
        void enqueueWorkflowEvent({
          organizationId,
          actorId: record.assignedTo,
          event,
          id: record.id,
          values: { email: record.email, replyIntent: intent, ...(status && { status }) },
          changed: status ? ['status'] : [],
          depth: 0,
        });
      }
    } catch (err) {
      logger.error({ err, activityId }, 'Failed to apply email reply side effects');
    }
  }
}

export const recordEmailsService = new RecordEmailsService();
