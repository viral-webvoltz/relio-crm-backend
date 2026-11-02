import type { Response } from 'express';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { tagsService } from './tags.service.js';
import type { CreateTagInput, TagContactsQuery, UpdateTagInput } from './tags.validation.js';

type IdParams = { id: string };
type ContactParams = { contactId: string };

class TagsController {
  async list(req: ValidatedRequest<object>, res: Response) {
    sendSuccess(res, { data: await tagsService.list(req.auth.organizationId) });
  }

  async create(req: ValidatedRequest<{ body: CreateTagInput }>, res: Response) {
    const data = await tagsService.create({ organizationId: req.auth.organizationId, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Tag created', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateTagInput }>, res: Response) {
    const data = await tagsService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Tag updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await tagsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Tag deleted' });
  }

  async contacts(req: ValidatedRequest<{ params: IdParams; query: TagContactsQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await tagsService.contactsOf({ organizationId: req.auth.organizationId, id: req.validated.params.id, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async setForContact(req: ValidatedRequest<{ params: ContactParams; body: { tagIds: string[] } }>, res: Response) {
    const data = await tagsService.setContactTags({
      organizationId: req.auth.organizationId,
      contactId: req.validated.params.contactId,
      tagIds: req.validated.body.tagIds,
    });
    sendSuccess(res, { message: 'Contact tags updated', data });
  }

  async forContact(req: ValidatedRequest<{ params: ContactParams }>, res: Response) {
    const data = await tagsService.forContact({ organizationId: req.auth.organizationId, contactId: req.validated.params.contactId });
    sendSuccess(res, { data });
  }
}

export const tagsController = new TagsController();
