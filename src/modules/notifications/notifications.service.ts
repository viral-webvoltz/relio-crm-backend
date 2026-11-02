import { NotFoundError } from '@/shared/errors/index.js';
import { notificationsRepository } from './notifications.repository.js';
import type { NotificationListQuery } from './notifications.validation.js';

class NotificationsService {
  list({ organizationId, userId, query }: { organizationId: string; userId: string; query: NotificationListQuery }) {
    return notificationsRepository.list({ organizationId, userId, query });
  }

  async markRead(scope: { organizationId: string; userId: string; id: string }) {
    const row = await notificationsRepository.markRead(scope);
    if (!row) throw new NotFoundError('Notification not found');
    return row;
  }

  async markAllRead(scope: { organizationId: string; userId: string }) {
    return { updated: await notificationsRepository.markAllRead(scope) };
  }
}

export const notificationsService = new NotificationsService();
