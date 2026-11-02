import type { Response } from 'express';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { notificationsService } from './notifications.service.js';
import type { NotificationListQuery } from './notifications.validation.js';

class NotificationsController {
  async list(req: ValidatedRequest<{ query: NotificationListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total, unreadCount } = await notificationsService.list({ organizationId: req.auth.organizationId, userId: req.auth.userId, query });
    // Built by hand: sendSuccess has no top-level unreadCount.
    res.status(200).json({ success: true, message: 'OK', data: rows, meta: pageMeta({ ...query }, total), unreadCount });
  }

  async markRead(req: ValidatedRequest<{ params: { id: string } }>, res: Response) {
    const data = await notificationsService.markRead({ organizationId: req.auth.organizationId, userId: req.auth.userId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Notification marked as read', data });
  }

  async markAllRead(req: ValidatedRequest<Record<string, never>>, res: Response) {
    const data = await notificationsService.markAllRead({ organizationId: req.auth.organizationId, userId: req.auth.userId });
    sendSuccess(res, { message: 'Notifications marked as read', data });
  }
}

export const notificationsController = new NotificationsController();
