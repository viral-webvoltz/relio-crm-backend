import { withTransaction } from '@/config/database.js';
import type { AppointmentStatus } from '@/database/schema/portal-extras.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { appointmentsRepository } from './appointments.repository.js';
import type { AppointmentListQuery, UpdateAppointmentInput } from './appointments.validation.js';

export const allowedTransitions: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  requested: ['confirmed', 'declined'],
  confirmed: ['completed', 'cancelled'],
  declined: [],
  cancelled: [],
  completed: [],
};

class AppointmentsService {
  list(organizationId: string, query: AppointmentListQuery) {
    return appointmentsRepository.list(organizationId, query);
  }

  async get(organizationId: string, id: string) {
    const row = await appointmentsRepository.find(organizationId, id);
    if (!row) throw new NotFoundError('Appointment not found');
    return row;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateAppointmentInput }) {
    await withTransaction(async (tx) => {
      const current = await appointmentsRepository.findForUpdate(organizationId, id, tx);
      if (!current) throw new NotFoundError('Appointment not found');
      if (input.status && input.status !== current.status && !allowedTransitions[current.status].includes(input.status)) {
        throw new ConflictError(`Cannot change an appointment from ${current.status} to ${input.status}`, 'INVALID_STATUS');
      }
      if (input.assignedTo && !(await appointmentsRepository.activeUserExists(organizationId, input.assignedTo, tx))) {
        throw new BadRequestError('Assignee not found', 'INVALID_ASSIGNEE');
      }
      await appointmentsRepository.update(organizationId, id, input, tx);
    });
    return this.get(organizationId, id);
  }
}

export const appointmentsService = new AppointmentsService();
