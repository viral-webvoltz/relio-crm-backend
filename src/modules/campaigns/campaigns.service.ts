import { randomBytes, randomUUID } from 'node:crypto';
import { appConfig } from '@/config/app.config.js';
import { withTransaction } from '@/config/database.js';
import { env } from '@/config/env.js';
import { campaignRecipients, emailCampaigns, emailOutbox, type CampaignAudience } from '@/database/schema/index.js';
import { newMessageId } from '@/modules/mail/mail.headers.js';
import { activeUserEmails, canSendMail, queueEmail } from '@/modules/mail/mail.service.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { logger } from '@/shared/utils/logger.js';
import { campaignsRepository } from './campaigns.repository.js';
import { extractLinks, hasUnsubscribe, renderCampaign, rewriteLinks, SAMPLE_RECIPIENT, withOpenPixel } from './campaigns.render.js';
import {
  MAX_RECIPIENTS,
  type CampaignListQuery,
  type CreateCampaignInput,
  type ScheduleCampaignInput,
  type TestCampaignInput,
  type UpdateCampaignInput,
} from './campaigns.validation.js';

const BATCH = 500;
const MAX_SCHEDULE_AHEAD_MS = 365 * 86_400_000;
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fullName = (c: { firstName: string; lastName: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(' ');
// Usable addresses only, one per mailbox: what both the preview and the launch count.
const usableByMailbox = <T extends { email: string | null }>(people: T[]) => {
  const seen = new Set<string>();
  return people.filter((p) => {
    const key = (p.email ?? '').trim().toLowerCase();
    if (!emailShape.test(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const mask = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');
const apiBase = () => `${env.API_URL.replace(/\/$/, '')}${appConfig.apiPrefix}`;

type Campaign = typeof emailCampaigns.$inferSelect;

async function requireMail(organizationId: string) {
  if (!(await canSendMail(organizationId))) throw new AppError('Email is not configured', 503, 'MAIL_NOT_CONFIGURED');
}

class CampaignsService {
  async list({ organizationId, query }: { organizationId: string; query: CampaignListQuery }) {
    return campaignsRepository.list({ organizationId, query });
  }

  async getById({ organizationId, id }: { organizationId: string; id: string }) {
    const campaign = await this.find(organizationId, id);
    return { ...campaign, stats: await campaignsRepository.stats({ campaignId: id }) };
  }

  async create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateCampaignInput }) {
    await this.checkAudience(organizationId, input.audience);
    return campaignsRepository.insert({ ...input, organizationId, createdBy: userId });
  }

  // Draft and scheduled campaigns can be edited; the content is only rendered when the campaign launches.
  update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateCampaignInput }) {
    return withTransaction(async (tx) => {
      const campaign = await campaignsRepository.lockById({ organizationId, id }, tx);
      if (!campaign) throw new NotFoundError('Campaign not found');
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled')
        throw new ConflictError(`A ${campaign.status} campaign can no longer be edited`, 'CAMPAIGN_LOCKED');
      if (input.audience) await this.checkAudience(organizationId, input.audience);
      return campaignsRepository.update({ id, set: input }, tx);
    });
  }

  async duplicate({ organizationId, userId, id }: { organizationId: string; userId: string; id: string }) {
    const { name, subject, bodyHtml, bodyText, audience } = await this.find(organizationId, id);
    return campaignsRepository.insert({ organizationId, name: `${name} (copy)`.slice(0, 120), subject, bodyHtml, bodyText, audience, createdBy: userId });
  }

  remove({ organizationId, id }: { organizationId: string; id: string }) {
    return withTransaction(async (tx) => {
      const campaign = await campaignsRepository.lockById({ organizationId, id }, tx);
      if (!campaign) throw new NotFoundError('Campaign not found');
      if (campaign.status !== 'draft' && campaign.status !== 'cancelled')
        throw new ConflictError('Only a draft or cancelled campaign can be deleted', 'CAMPAIGN_LOCKED');
      await campaignsRepository.remove({ id }, tx);
    });
  }

  // Who would get it right now: nothing is sent or stored.
  async audience({ organizationId, id }: { organizationId: string; id: string }) {
    const campaign = await this.find(organizationId, id);
    const { matched, eligible } = await campaignsRepository.audience({ organizationId, audience: campaign.audience, limit: MAX_RECIPIENTS + 1 });
    const usable = usableByMailbox(eligible);
    return {
      matched,
      willReceive: Math.min(usable.length, MAX_RECIPIENTS),
      skipped: matched - usable.length,
      tooLarge: usable.length > MAX_RECIPIENTS,
      sample: usable.slice(0, 5).map((c) => ({ name: fullName(c), email: c.email })),
    };
  }

  // A rendered copy to a colleague, so the author can check it before the real send. No tracking, no recipients stored.
  async sendTest({ organizationId, id, input }: { organizationId: string; id: string; input: TestCampaignInput }) {
    await requireMail(organizationId);
    const campaign = await this.find(organizationId, id);
    if ((await activeUserEmails(organizationId, [input.to])).length === 0) {
      throw new BadRequestError('A test can only go to a user of this organization', 'RECIPIENT_NOT_ALLOWED');
    }
    const mail = renderCampaign(campaign, SAMPLE_RECIPIENT);
    if (
      !(await queueEmail({
        organizationId,
        kind: 'campaign_test',
        to: input.to,
        ...mail,
        subject: `[Test] ${mail.subject}`,
        relatedType: 'campaign',
        relatedId: id,
      }))
    ) {
      throw new Error('Failed to queue email');
    }
  }

  async schedule({ organizationId, id, input }: { organizationId: string; id: string; input: ScheduleCampaignInput }) {
    const at = new Date(input.at);
    if (at.getTime() <= Date.now()) throw new BadRequestError('Pick a time in the future', 'INVALID_SCHEDULE');
    if (at.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw new BadRequestError('Pick a time within the next year', 'INVALID_SCHEDULE');
    return withTransaction(async (tx) => {
      const campaign = await campaignsRepository.lockById({ organizationId, id }, tx);
      if (!campaign) throw new NotFoundError('Campaign not found');
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled')
        throw new ConflictError(`A ${campaign.status} campaign cannot be scheduled`, 'CAMPAIGN_LOCKED');
      if (!hasUnsubscribe(campaign)) throw new BadRequestError('Add {{unsubscribe_link}} to both the HTML and the text body', 'MISSING_UNSUBSCRIBE');
      return campaignsRepository.update({ id, set: { status: 'scheduled', scheduledAt: at, lastError: null } }, tx);
    });
  }

  // Scheduled: back to draft. Sent: whatever has not gone out yet is held back and the campaign is marked cancelled.
  cancel({ organizationId, id }: { organizationId: string; id: string }) {
    return withTransaction(async (tx) => {
      const campaign = await campaignsRepository.lockById({ organizationId, id }, tx);
      if (!campaign) throw new NotFoundError('Campaign not found');
      if (campaign.status === 'scheduled')
        return { campaign: await campaignsRepository.update({ id, set: { status: 'draft', scheduledAt: null } }, tx), held: 0 };
      if (campaign.status !== 'sent') throw new ConflictError(`A ${campaign.status} campaign cannot be cancelled`, 'CAMPAIGN_LOCKED');
      const held = await campaignsRepository.cancelQueued({ campaignId: id }, tx);
      return { campaign: await campaignsRepository.update({ id, set: { status: 'cancelled' } }, tx), held };
    });
  }

  // Fixes the recipient list at this moment and queues one personalised email each, all in one transaction: either everyone is queued or no one is.
  // The mailer then sends them at its own pace.
  async launch({ organizationId, userId, id }: { organizationId: string; userId: string | null; id: string }) {
    await requireMail(organizationId);
    return withTransaction(async (tx) => {
      const campaign = await campaignsRepository.lockById({ organizationId, id }, tx);
      if (!campaign) throw new NotFoundError('Campaign not found');
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled')
        throw new ConflictError(`A ${campaign.status} campaign cannot be launched`, 'CAMPAIGN_LOCKED');
      if (!hasUnsubscribe(campaign)) throw new BadRequestError('Add {{unsubscribe_link}} to both the HTML and the text body', 'MISSING_UNSUBSCRIBE');

      const { matched, eligible } = await campaignsRepository.audience({ organizationId, audience: campaign.audience, limit: MAX_RECIPIENTS + 1 }, tx);
      const people = usableByMailbox(eligible);
      if (people.length > MAX_RECIPIENTS)
        throw new BadRequestError(`A campaign can go to at most ${MAX_RECIPIENTS} people; narrow the audience`, 'AUDIENCE_TOO_LARGE');
      if (people.length === 0) throw new BadRequestError('Nobody in this audience can receive email', 'NO_RECIPIENTS');

      const links = await campaignsRepository.insertLinks(
        extractLinks(campaign.bodyHtml).map((url) => ({ campaignId: id, url })),
        tx,
      );
      const linkIdFor = new Map(links.map((l) => [l.url, l.id]));

      const base = apiBase();
      const unique: { recipient: typeof campaignRecipients.$inferInsert; outbox: typeof emailOutbox.$inferInsert }[] = [];
      const seen = new Set<string>();
      for (const person of people) {
        const email = person.email!.trim();
        if (seen.has(email.toLowerCase())) continue; // two contacts, one mailbox: send once
        seen.add(email.toLowerCase());
        const token = randomBytes(24).toString('hex');
        const html = withOpenPixel(
          rewriteLinks(campaign.bodyHtml, (url) => (linkIdFor.has(url) ? `${base}/public/campaigns/c/${linkIdFor.get(url)}/${token}` : undefined)),
          `${base}/public/campaigns/o/${token}.gif`,
        );
        const mail = renderCampaign(
          { subject: campaign.subject, bodyHtml: html, bodyText: campaign.bodyText },
          {
            first_name: person.firstName,
            last_name: person.lastName ?? '',
            full_name: fullName(person),
            email,
            unsubscribe_link: `${env.APP_URL.replace(/\/$/, '')}/unsubscribe/${token}`,
          },
        );
        const outboxId = randomUUID();
        const mailRow = {
          id: outboxId,
          organizationId,
          kind: 'campaign',
          toEmail: email,
          subject: mail.subject,
          bodyHtml: mail.html,
          bodyText: mail.text,
          relatedType: 'campaign',
          relatedId: id,
          messageId: newMessageId(env.MAIL_FROM!),
          // One-click unsubscribe (RFC 8058): mail clients POST to this URL themselves.
          headers: { 'List-Unsubscribe': `<${base}/public/unsubscribe/${token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        };
        unique.push({ outbox: mailRow, recipient: { organizationId, campaignId: id, contactId: person.id, email: email.toLowerCase(), token, outboxId } });
      }

      for (let i = 0; i < unique.length; i += BATCH) {
        const chunk = unique.slice(i, i + BATCH);
        await campaignsRepository.insertOutbox(
          chunk.map((c) => c.outbox),
          tx,
        );
        await campaignsRepository.insertRecipients(
          chunk.map((c) => c.recipient),
          tx,
        );
      }
      const launched = await campaignsRepository.update(
        { id, set: { status: 'sent', launchedAt: new Date(), skippedCount: matched - unique.length, scheduledAt: null, lastError: null } },
        tx,
      );
      await audit(
        { organizationId, actorUserId: userId, action: 'campaign.launched', targetType: 'campaign', targetId: id, metadata: { recipients: unique.length } },
        tx,
      );
      return launched;
    });
  }

  // The scheduler's entry point: a campaign that cannot launch goes back to draft with the reason, instead of failing every minute.
  async launchScheduled(due: { id: string; organizationId: string; createdBy: string | null }) {
    try {
      await this.launch({ organizationId: due.organizationId, userId: due.createdBy, id: due.id });
    } catch (err) {
      if (err instanceof ConflictError) return; // another instance launched it first
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ campaignId: due.id, reason }, 'Scheduled campaign could not launch');
      await campaignsRepository.update({ id: due.id, set: { status: 'draft', scheduledAt: null, lastError: reason.slice(0, 500) } });
    }
  }

  recipients({ organizationId, id, page, limit }: { organizationId: string; id: string; page: number; limit: number }) {
    return this.find(organizationId, id).then(() => campaignsRepository.listRecipients({ campaignId: id, page, limit }));
  }

  // ---- suppressions ----

  listSuppressions({ organizationId, page, limit }: { organizationId: string; page: number; limit: number }) {
    return campaignsRepository.listSuppressions({ organizationId, page, limit });
  }

  async addSuppression({ organizationId, email }: { organizationId: string; email: string }) {
    await campaignsRepository.suppress({ organizationId, email, reason: 'manual' });
  }

  async removeSuppression({ organizationId, id }: { organizationId: string; id: string }) {
    if (!(await campaignsRepository.removeSuppression({ organizationId, id }))) throw new NotFoundError('Suppression not found');
  }

  // ---- the recipient side: the token in the link is the only credential, and it can do nothing but what is below ----

  async unsubscribeInfo(token: string) {
    const recipient = await campaignsRepository.findRecipient({ token });
    if (!recipient) throw new NotFoundError('Link not found');
    return { email: mask(recipient.email), organizationName: recipient.organizationName, unsubscribed: recipient.unsubscribedAt !== null };
  }

  async unsubscribe(token: string) {
    const recipient = await campaignsRepository.findRecipient({ token });
    if (!recipient) throw new NotFoundError('Link not found');
    await campaignsRepository.suppress({ organizationId: recipient.organizationId, email: recipient.email, reason: 'unsubscribed' });
    await campaignsRepository.markUnsubscribed({ id: recipient.id });
    await campaignsRepository.cancelQueuedFor({ organizationId: recipient.organizationId, email: recipient.email });
    await audit({
      organizationId: recipient.organizationId,
      action: 'campaign.unsubscribed',
      targetType: 'campaign',
      targetId: recipient.campaignId,
      metadata: { email: recipient.email },
    });
    return { email: mask(recipient.email), organizationName: recipient.organizationName, unsubscribed: true };
  }

  // Never throws: a broken tracking pixel must not matter to the reader.
  trackOpen(file: string) {
    return campaignsRepository.markOpened({ token: file.replace(/\.gif$/, '') }).catch((err: unknown) => logger.warn({ err }, 'open tracking failed'));
  }

  async clickTarget(linkId: string, token: string) {
    const url = await campaignsRepository.clickTarget({ linkId, token });
    if (!url) throw new NotFoundError('Link not found');
    return url;
  }

  // ---- helpers ----

  private async find(organizationId: string, id: string): Promise<Campaign> {
    const campaign = await campaignsRepository.findById({ organizationId, id });
    if (!campaign) throw new NotFoundError('Campaign not found');
    return campaign;
  }

  private async checkAudience(organizationId: string, audience: CampaignAudience) {
    if (audience.type === 'tag' && !(await campaignsRepository.tagExists({ organizationId, id: audience.tagId })))
      throw new BadRequestError('Tag not found', 'INVALID_AUDIENCE');
    if (audience.type === 'company' && !(await campaignsRepository.companyExists({ organizationId, id: audience.companyId }))) {
      throw new BadRequestError('Company not found', 'INVALID_AUDIENCE');
    }
  }
}

export const campaignsService = new CampaignsService();
