import { z } from 'zod';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const notificationListQuerySchema = listQuerySchema.pick({ page: true, limit: true });

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
