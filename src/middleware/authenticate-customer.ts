import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import * as portalAuthService from '@/modules/portal/portal.auth.js';

// A different cookie from staff sessions ("sid"), so one kind of login can never be mistaken for the other.
export const customerCookieName = 'csid';

export const authenticateCustomer: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[customerCookieName];
  const customer = token ? await portalAuthService.getCustomerBySessionToken(token) : null;
  if (!customer) throw new UnauthorizedError('Please sign in');
  // A staff-chosen password must be replaced first: only reading the profile and changing the password are allowed.
  const allowed = (req.method === 'GET' && req.path === '/me') || (req.method === 'POST' && req.path === '/me/password');
  if (customer.mustChangePassword && !allowed) throw new ForbiddenError('Please change your password to continue', 'PASSWORD_CHANGE_REQUIRED');
  req.customer = customer;
  next();
};
