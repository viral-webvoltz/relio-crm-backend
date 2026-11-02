import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { appointmentsService } from './appointments.service.js';
import type { AppointmentListQuery, UpdateAppointmentInput } from './appointments.validation.js';

type IdParams = { id: string };

class AppointmentsController {
  async list(req: ValidatedRequest<{ query: AppointmentListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await appointmentsService.list(req.auth.organizationId, query);
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await appointmentsService.get(req.auth.organizationId, req.validated.params.id) });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateAppointmentInput }>, res: Response) {
    const row = await appointmentsService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Appointment updated', data: row });
  }
}

export const appointmentsController = new AppointmentsController();
