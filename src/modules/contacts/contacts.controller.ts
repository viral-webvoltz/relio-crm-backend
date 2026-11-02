import type { Response } from 'express';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { assertBatchPermission } from '@/shared/batch/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { contactsService } from './contacts.service.js';
import type { ContactListQuery } from './contacts.validation.js';
import type { CreateContactInput, UpdateContactInput, BatchContactsInput } from './contacts.validation.js';

type IdParams = { id: string };

class ContactsController {
  async list(req: ValidatedRequest<{ query: ContactListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await contactsService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await contactsService.get({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { data });
  }

  async create(req: ValidatedRequest<{ body: CreateContactInput }>, res: Response) {
    const data = await contactsService.create({ organizationId: req.auth.organizationId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Contact created', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateContactInput }>, res: Response) {
    const data = await contactsService.update({
      organizationId: req.auth.organizationId,
      id: req.validated.params.id,
      input: req.validated.body,
    });
    sendSuccess(res, { message: 'Contact updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await contactsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id, userId: req.auth.userId });
    sendSuccess(res, { message: 'Contact deleted' });
  }

  async trash(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await contactsService.listDeleted({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async restore(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const data = await contactsService.restore({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Contact restored', data });
  }

  async batch(req: ValidatedRequest<{ body: BatchContactsInput }>, res: Response) {
    const input = req.validated.body;
    assertBatchPermission(req.auth, input.action === 'delete' ? 'contacts.delete' : 'contacts.update');
    sendSuccess(res, { data: await contactsService.batch({ organizationId: req.auth.organizationId, userId: req.auth.userId, input }) });
  }
}

export const contactsController = new ContactsController();
