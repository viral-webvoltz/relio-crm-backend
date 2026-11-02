import type { RequestHandler } from 'express';
import type { PermissionKey } from '@/shared/constants/permissions.js';
import { ForbiddenError } from '@/shared/errors/index.js';

// Handler -> permission keys, read by the OpenAPI generator (src/modules/docs).
export const routePermissions = new WeakMap<RequestHandler, PermissionKey[]>();

// Allows the request if the authenticated user holds at least one of the given permissions.
export const authorize = (...keys: PermissionKey[]): RequestHandler => {
  const handler: RequestHandler = (req, _res, next) => (keys.some((key) => req.auth.permissions.includes(key)) ? next() : next(new ForbiddenError()));
  routePermissions.set(handler, keys);
  return handler;
};
