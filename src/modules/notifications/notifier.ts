import { logger } from '@/shared/utils/logger.js';
import { notificationsRepository } from './notifications.repository.js';

export type NotifyInput = {
  organizationId: string;
  userId: string | null | undefined;
  actorId?: string | null;
  type: string;
  title: string;
  body?: string;
  link?: string;
  relatedType?: string;
  relatedId?: string;
};

// Called after the triggering change has succeeded. Never throws: a failed notification must not fail the request.
export async function notify({ actorId, userId, ...rest }: NotifyInput): Promise<void> {
  if (!userId || userId === actorId) return;
  try {
    await notificationsRepository.insert({ ...rest, userId });
  } catch (err) {
    logger.error({ err, type: rest.type }, 'Failed to create notification');
  }
}
