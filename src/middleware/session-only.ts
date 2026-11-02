import type { RequestHandler } from 'express';
import { ForbiddenError } from '@/shared/errors/index.js';

// For things only a signed-in person may do (managing API keys, passwords, two-factor): a request made with an API key is refused,
// so a leaked key can never be used to widen its own reach. Put it right after `authenticate`.
export const sessionOnly: RequestHandler = (req, _res, next) =>
  req.auth.apiKeyId ? next(new ForbiddenError('This needs a signed-in user, not an API key', 'SESSION_REQUIRED')) : next();
