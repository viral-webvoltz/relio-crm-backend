import type { Request, Response } from 'express';
import { env } from '@/config/env.js';
import { customerCookieName } from '@/middleware/authenticate-customer.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { pageMeta, type ListQuery } from '@/shared/pagination/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { supportPortalService } from '@/modules/support/support.portal.service.js';
import type { PortalCreateTicketInput, PortalReplyInput } from '@/modules/support/support.validation.js';
import { loginCustomer, logoutCustomer } from './portal.auth.js';
import { serializeTicket, serializeTicketMessage } from './portal.serializers.js';
import { portalService } from './portal.service.js';
import type { ChangePasswordInput, CreateAppointmentInput, CustomerLoginInput, UpdateProfileInput } from './portal.validation.js';

type IdParams = { id: string };

// encodeURIComponent leaves ' ( ) * unescaped, which RFC 5987 attr-chars do not allow.
const encodeRfc5987 = (value: string) => encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

class PortalController {
  async login(req: ValidatedRequest<{ body: CustomerLoginInput }>, res: Response) {
    const session = await loginCustomer(req.validated.body);
    res.cookie(customerCookieName, session.token, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', expires: session.expiresAt });
    return sendSuccess(res, { message: 'Signed in' });
  }

  async logout(req: Request, res: Response) {
    const token = req.cookies?.[customerCookieName];
    if (token) await logoutCustomer(token);
    res.clearCookie(customerCookieName);
    return sendSuccess(res, { message: 'Signed out' });
  }

  async me(req: Request, res: Response) {
    return sendSuccess(res, { data: portalService.getProfile(req.customer) });
  }

  async updateMe(req: ValidatedRequest<{ body: UpdateProfileInput }>, res: Response) {
    return sendSuccess(res, { message: 'Profile updated', data: await portalService.updateProfile(req.customer, req.validated.body) });
  }

  async changePassword(req: ValidatedRequest<{ body: ChangePasswordInput }>, res: Response) {
    // The current session token is needed so that session is the one kept when the others are revoked.
    const token = req.cookies?.[customerCookieName];
    if (typeof token !== 'string') throw new UnauthorizedError('Please sign in');
    await portalService.changePassword({ customer: req.customer, token, ...req.validated.body });
    return sendSuccess(res, { message: 'Password changed' });
  }

  async listOrders(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await portalService.listOrders(req.customer, query);
    return sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async getOrder(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    return sendSuccess(res, { data: await portalService.getOrder(req.customer, req.validated.params.id) });
  }

  async listTickets(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await supportPortalService.listTickets(req.customer, query);
    return sendSuccess(res, { data: rows.map(serializeTicket), meta: pageMeta(query, total) });
  }

  async getTicket(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const ticket = await supportPortalService.getTicket(req.customer, req.validated.params.id);
    return sendSuccess(res, { data: { ...serializeTicket(ticket), messages: ticket.messages.map(serializeTicketMessage) } });
  }

  async createTicket(req: ValidatedRequest<{ body: PortalCreateTicketInput }>, res: Response) {
    const ticket = await supportPortalService.createTicket(req.customer, req.validated.body);
    return sendSuccess(res, { statusCode: 201, message: 'Ticket created', data: serializeTicket(ticket) });
  }

  async addTicketMessage(req: ValidatedRequest<{ params: IdParams; body: PortalReplyInput }>, res: Response) {
    const message = await supportPortalService.addReply({ customer: req.customer, id: req.validated.params.id, body: req.validated.body.body });
    return sendSuccess(res, { statusCode: 201, message: 'Reply sent', data: serializeTicketMessage(message) });
  }

  async listInvoices(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await portalService.listInvoices(req.customer, query);
    return sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async getInvoice(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    return sendSuccess(res, { data: await portalService.getInvoice(req.customer, req.validated.params.id) });
  }

  async listNotices(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await portalService.listNotices(req.customer, query);
    return sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async listDocuments(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await portalService.listDocuments(req.customer, query);
    return sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async downloadDocument(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    const doc = await portalService.getDocumentForDownload(req.customer, req.validated.params.id);
    res.set({
      'Content-Type': doc.mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeRfc5987(doc.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Length': String(doc.content.length),
    });
    res.end(doc.content);
  }

  async listAppointments(req: ValidatedRequest<{ query: ListQuery }>, res: Response) {
    const query = req.validated.query;
    const { rows, total } = await portalService.listAppointments(req.customer, query);
    return sendSuccess(res, { data: rows, meta: pageMeta(query, total) });
  }

  async getAppointment(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    return sendSuccess(res, { data: await portalService.getAppointment(req.customer, req.validated.params.id) });
  }

  async createAppointment(req: ValidatedRequest<{ body: CreateAppointmentInput }>, res: Response) {
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Appointment requested',
      data: await portalService.createAppointment(req.customer, req.validated.body),
    });
  }

  async cancelAppointment(req: ValidatedRequest<{ params: IdParams }>, res: Response) {
    return sendSuccess(res, { message: 'Appointment cancelled', data: await portalService.cancelAppointment(req.customer, req.validated.params.id) });
  }
}

export const portalController = new PortalController();
