import type { RequestHandler } from 'express';
import { env } from '@/config/env.js';
import { ForbiddenError } from '@/shared/errors/index.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// The session cookie is SameSite=None in production, so this origin check is the CSRF defence: it refuses state-changing
// requests that a browser marks as coming from any origin other than CORS_ORIGIN. Requests without an Origin header (curl, server-to-server
// such as the inbound email hook) are not browser cross-site requests and pass.
export const csrfOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.get('origin');
  if (safeMethods.has(req.method) || !origin) return next();
  const allowed = origin === env.CORS_ORIGIN || origin === `${req.protocol}://${req.get('host')}`;
  return allowed ? next() : next(new ForbiddenError('Cross-origin request blocked', 'CSRF_BLOCKED'));
};
