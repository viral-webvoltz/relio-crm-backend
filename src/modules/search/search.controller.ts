import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { ForbiddenError } from '@/shared/errors/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { searchService, VIEW_PERMISSION } from './search.service.js';
import type { SearchQuery } from './search.validation.js';

class SearchController {
  async search(req: ValidatedRequest<{ query: SearchQuery }>, res: Response) {
    const { q, types, limit } = req.validated.query;
    // Types the caller cannot view are silently dropped; only a caller who can view none gets a 403.
    const allowed = types.filter((t) => req.auth.permissions.includes(VIEW_PERMISSION[t]));
    if (!allowed.length) throw new ForbiddenError();
    const data = await searchService.search({ organizationId: req.auth.organizationId, q, types: allowed, limit });
    sendSuccess(res, { data });
  }
}

export const searchController = new SearchController();
