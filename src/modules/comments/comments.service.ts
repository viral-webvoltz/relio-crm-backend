import { notify } from '@/modules/notifications/notifier.js';
import { ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { commentsRepository } from './comments.repository.js';
import { parseMentions } from './mentions.js';
import type { CommentListQuery, CreateCommentInput } from './comments.validation.js';

type Actor = { organizationId: string; userId: string; fullName: string; permissions: readonly string[] };
type Target = { entityType: 'deal' | 'ticket'; entityId: string };

const link = ({ entityType, entityId }: Target) => (entityType === 'deal' ? '/deals' : `/support/${entityId}`);

// Closest existing permissions: comments are staff-internal notes on the target.
const needed = { read: { deal: 'deals.view', ticket: 'tickets.view' }, write: { deal: 'deals.update', ticket: 'tickets.reply' } } as const;

function assertCan(actor: Actor, mode: 'read' | 'write', entityType: 'deal' | 'ticket') {
  if (!actor.permissions.includes(needed[mode][entityType])) throw new ForbiddenError();
}

class CommentsService {
  list({ actor, query }: { actor: Actor; query: CommentListQuery }) {
    assertCan(actor, 'read', query.entityType);
    return commentsRepository.list({ organizationId: actor.organizationId, query });
  }

  async create({ actor, input }: { actor: Actor; input: CreateCommentInput }) {
    assertCan(actor, 'write', input.entityType);
    const { organizationId } = actor;
    const title = await commentsRepository.targetTitle({ organizationId, entityType: input.entityType, entityId: input.entityId });
    if (title === undefined) throw new NotFoundError(`${input.entityType === 'deal' ? 'Deal' : 'Ticket'} not found`);
    const mentions = await this.validMentions(organizationId, input.body);
    const row = await commentsRepository.insert({
      organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      authorId: actor.userId,
      body: input.body,
      mentions,
    });
    if (!row) throw new Error('Comment insert returned no row');
    await this.notifyMentions({ actor, target: input, title, userIds: mentions });
    return row;
  }

  async update({ actor, id, body }: { actor: Actor; id: string; body: string }) {
    const { organizationId } = actor;
    const existing = await commentsRepository.findById({ organizationId, id });
    if (!existing) throw new NotFoundError('Comment not found');
    if (existing.authorId !== actor.userId) throw new ForbiddenError('Only the author can edit a comment', 'FORBIDDEN');
    const mentions = await this.validMentions(organizationId, body);
    const row = await commentsRepository.update({ organizationId, id, body, mentions });
    if (!row) throw new NotFoundError('Comment not found');
    const added = mentions.filter((m) => !existing.mentions.includes(m));
    const { entityType, entityId } = existing;
    if (added.length > 0 && (entityType === 'deal' || entityType === 'ticket')) {
      const target: Target = { entityType, entityId };
      const title = (await commentsRepository.targetTitle({ organizationId, ...target })) ?? '';
      await this.notifyMentions({ actor, target, title, userIds: added });
    }
    return row;
  }

  async remove({ actor, id }: { actor: Actor; id: string }) {
    const existing = await commentsRepository.findById({ organizationId: actor.organizationId, id });
    if (!existing) throw new NotFoundError('Comment not found');
    if (existing.authorId !== actor.userId && !actor.permissions.includes('settings.manage')) {
      throw new ForbiddenError('You cannot delete this comment', 'FORBIDDEN');
    }
    await commentsRepository.softDelete({ organizationId: actor.organizationId, id });
  }

  // Only active users of the same organization can be mentioned; anything else in the tokens is dropped.
  private validMentions(organizationId: string, body: string) {
    return commentsRepository.activeUserIds({ organizationId, ids: parseMentions(body) });
  }

  private async notifyMentions({ actor, target, title, userIds }: { actor: Actor; target: Target; title: string; userIds: string[] }) {
    await Promise.all(
      userIds.map((userId) =>
        notify({
          organizationId: actor.organizationId,
          userId,
          actorId: actor.userId,
          type: 'mention',
          title: `${actor.fullName} mentioned you in a ${target.entityType} comment`,
          body: title,
          link: link(target),
          relatedType: target.entityType,
          relatedId: target.entityId,
        }),
      ),
    );
  }
}

export const commentsService = new CommentsService();
