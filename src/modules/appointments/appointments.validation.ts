import { z } from 'zod';
import { appointmentStatuses } from '@/database/schema/portal-extras.js';
import { listQuerySchema } from '@/shared/pagination/index.js';

export const appointmentListQuerySchema = listQuerySchema.extend({
  status: z.enum(appointmentStatuses).optional(),
  contactId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const updateAppointmentSchema = z
  .object({
    status: z.enum(appointmentStatuses),
    startsAt: z.coerce.date(),
    durationMinutes: z.number().int().min(15).max(240),
    assignedTo: z.uuid().nullable(),
    staffNotes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
