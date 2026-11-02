import type { Response } from 'express';
import { pageMeta } from '@/shared/pagination/index.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { commentsService } from './comments.service.js';
import type { CommentListQuery, CreateCommentInput, UpdateCommentInput } from './comments.validation.js';

type IdParams = { id: string };

class CommentsController {
  async list(req: ValidatedRequest<{ query: CommentListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await commentsService.list({ actor: req.auth, query });
    sendSuccess(res, { data: rows, meta: pageMeta({ page: query.page, limit: query.limit }, total) });
  }

  async create(req: ValidatedRequest<{ body: CreateCommentInput }>, res: Response) {
    const data = await commentsService.create({ actor: req.auth, input: req.validated.body });
    sendSuccess(res, { statusCode: 201, message: 'Comment added', data });
  }

  async update(req: ValidatedRequest<{ params: IdParams; body: UpdateCommentInput }>, res: Response) {
    const data = await commentsService.update({ actor: req.auth, id: req.validated.params.id, body: req.validated.body.body });
    sendSuccess(res, { message: 'Comment updated', data });
  }

  async remove(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    await commentsService.remove({ actor: req.auth, id: req.validated.params.id });
    sendSuccess(res, { message: 'Comment deleted' });
  }
}

export const commentsController = new CommentsController();
