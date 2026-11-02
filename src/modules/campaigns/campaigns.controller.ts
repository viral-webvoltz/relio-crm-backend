import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { pageMeta, type ListQuery } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { GIF_1X1 } from './campaigns.render.js';
import { campaignsService } from './campaigns.service.js';
import type { CampaignListQuery, CreateCampaignInput, ScheduleCampaignInput, TestCampaignInput, UpdateCampaignInput } from './campaigns.validation.js';

type IdParams = { id: string };
type TokenParams = { token: string };

class CampaignsController {
  async list(req: ValidatedRequest<{ query: CampaignListQuery }>, res: Response) {
    const { query } = req.validated;
    const { rows, total } = await campaignsService.list({ organizationId: req.auth.organizationId, query });
    sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async get(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await campaignsService.getById({ organizationId: req.auth.organizationId, id: req.validated.params.id }) });
  }

  async create(req: ValidatedRequest<{ body: CreateCampaignInput }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, {
      statusCode: 201,
      message: 'Campaign created',
      data: await campaignsService.create({ organizationId, userId, input: req.validated.body }),
    });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateCampaignInput }>, res: Response) {
    const data = await campaignsService.update({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Campaign updated', data });
  }

  async duplicate(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, {
      statusCode: 201,
      message: 'Campaign duplicated',
      data: await campaignsService.duplicate({ organizationId, userId, id: req.validated.params.id }),
    });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await campaignsService.remove({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Campaign deleted' });
  }

  async audience(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, { data: await campaignsService.audience({ organizationId: req.auth.organizationId, id: req.validated.params.id }) });
  }

  async test(req: ValidatedRequest<{ params: IdParams; body: TestCampaignInput }>, res: Response) {
    await campaignsService.sendTest({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { statusCode: 202, message: 'Test email queued' });
  }

  async launch(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const { organizationId, userId } = req.auth;
    sendSuccess(res, {
      statusCode: 202,
      message: 'Campaign launched',
      data: await campaignsService.launch({ organizationId, userId, id: req.validated.params.id }),
    });
  }

  async schedule(req: ValidatedRequest<{ params: IdParams; body: ScheduleCampaignInput }>, res: Response) {
    const data = await campaignsService.schedule({ organizationId: req.auth.organizationId, id: req.validated.params.id, input: req.validated.body });
    sendSuccess(res, { message: 'Campaign scheduled', data });
  }

  async cancel(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    sendSuccess(res, {
      message: 'Campaign cancelled',
      data: await campaignsService.cancel({ organizationId: req.auth.organizationId, id: req.validated.params.id }),
    });
  }

  async recipients(req: ValidatedRequest<{ params: IdParams; query: ListQuery }>, res: Response) {
    const { page, limit } = req.validated.query;
    const { rows, total } = await campaignsService.recipients({ organizationId: req.auth.organizationId, id: req.validated.params.id, page, limit });
    sendSuccess(res, { data: rows, meta: pageMeta(req.validated.query, total) });
  }

  async suppressions(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const { page, limit } = req.validated.query;
    const { rows, total } = await campaignsService.listSuppressions({ organizationId: req.auth.organizationId, page, limit });
    sendSuccess(res, { data: rows, meta: pageMeta(req.validated.query, total) });
  }

  async addSuppression(req: ValidatedRequest<{ body: { email: string } }>, res: Response) {
    await campaignsService.addSuppression({ organizationId: req.auth.organizationId, email: req.validated.body.email });
    sendSuccess(res, { statusCode: 201, message: 'Address suppressed' });
  }

  async removeSuppression(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await campaignsService.removeSuppression({ organizationId: req.auth.organizationId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Suppression removed' });
  }

  // ---- public: no session, the token in the path is the credential ----

  async unsubscribeInfo(req: ValidatedRequest<{ params: TokenParams }>, res: Response) {
    sendSuccess(res, { data: await campaignsService.unsubscribeInfo(req.validated.params.token) });
  }

  // Also the target of the mail client one-click POST, which sends a form body we do not need.
  async unsubscribe(req: ValidatedRequest<{ params: TokenParams }>, res: Response) {
    sendSuccess(res, { message: 'You have been unsubscribed', data: await campaignsService.unsubscribe(req.validated.params.token) });
  }

  // Always a 1x1 image, known token or not, so the pixel reveals nothing.
  async pixel(req: ValidatedRequest<{ params: { file: string } }>, res: Response) {
    void campaignsService.trackOpen(req.validated.params.file);
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(GIF_1X1);
  }

  async click(req: ValidatedRequest<{ params: { linkId: string; token: string } }>, res: Response) {
    res.redirect(302, await campaignsService.clickTarget(req.validated.params.linkId, req.validated.params.token));
  }
}

export const campaignsController = new CampaignsController();
