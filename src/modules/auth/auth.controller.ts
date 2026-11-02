import type { Request, Response } from 'express';
import { sessionCookieName, sessionCookieOptions, sessionTokenOf, setSessionCookie } from '@/middleware/authenticate.js';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { authService, hashToken } from './auth.service.js';
import { twoFactorService } from './two-factor.service.js';
import type {
  TwoFactorDisableInput,
  TwoFactorEnableInput,
  TwoFactorLoginInput,
  TwoFactorRecoveryCodesInput,
  TwoFactorSetupInput,
} from './two-factor.validation.js';
import type { ChangePasswordInput, ForgotPasswordInput, LoginInput, RegisterInput, ResetPasswordInput } from './auth.validation.js';

const sessionMeta = (req: Pick<Request, 'get' | 'ip'>) => ({ userAgent: req.get('user-agent')?.slice(0, 255) ?? null, ipAddress: req.ip ?? null });

// Only used behind `authenticate`, so the cookie is present; the check keeps the type honest.
const cookieToken = (req: Pick<Request, 'cookies' | 'get'>): string => {
  const token = sessionTokenOf(req);
  if (!token) throw new UnauthorizedError();
  return token;
};

class AuthController {
  async register(req: ValidatedRequest<{ body: RegisterInput }>, res: Response) {
    const session = await authService.registerOrganization(req.validated.body, sessionMeta(req));
    setSessionCookie(res, session);
    sendSuccess(res, { statusCode: 201, message: 'Organization created', data: session });
  }

  async login(req: ValidatedRequest<{ body: LoginInput }>, res: Response) {
    const result = await authService.login(req.validated.body, sessionMeta(req));
    // Two-factor on: no session yet, only a challenge to answer at POST /auth/login/2fa.
    if ('challengeToken' in result) {
      return sendSuccess(res, { message: 'Two-factor code required', data: { twoFactorRequired: true, challengeToken: result.challengeToken } });
    }
    setSessionCookie(res, result.session);
    sendSuccess(res, { message: 'Logged in', data: result.session });
  }

  async loginTwoFactor(req: ValidatedRequest<{ body: TwoFactorLoginInput }>, res: Response) {
    const session = await authService.completeTwoFactorLogin(req.validated.body, sessionMeta(req));
    setSessionCookie(res, session);
    sendSuccess(res, { message: 'Logged in', data: session });
  }

  async twoFactorStatus(req: Request, res: Response) {
    sendSuccess(res, { data: await twoFactorService.status(req.auth.userId) });
  }

  async twoFactorSetup(req: ValidatedRequest<{ body: TwoFactorSetupInput }>, res: Response) {
    const { userId, organizationId, email } = req.auth;
    sendSuccess(res, {
      message: 'Scan the code, then confirm with a 6-digit code',
      data: await twoFactorService.setup({ userId, organizationId, email, password: req.validated.body.password }),
    });
  }

  async twoFactorEnable(req: ValidatedRequest<{ body: TwoFactorEnableInput }>, res: Response) {
    const { userId, organizationId } = req.auth;
    const data = await twoFactorService.enable({ userId, organizationId, code: req.validated.body.code, keepTokenHash: hashToken(cookieToken(req)) });
    sendSuccess(res, { message: 'Two-factor authentication is on. Keep these recovery codes safe: they are shown only once.', data });
  }

  async twoFactorDisable(req: ValidatedRequest<{ body: TwoFactorDisableInput }>, res: Response) {
    const { userId, organizationId } = req.auth;
    const { password, code, recoveryCode } = req.validated.body;
    await twoFactorService.disable({ userId, organizationId, password, factor: { code, recoveryCode } });
    sendSuccess(res, { message: 'Two-factor authentication is off' });
  }

  async twoFactorRecoveryCodes(req: ValidatedRequest<{ body: TwoFactorRecoveryCodesInput }>, res: Response) {
    const { userId, organizationId } = req.auth;
    sendSuccess(res, {
      message: 'New recovery codes. The old ones no longer work.',
      data: await twoFactorService.regenerateRecoveryCodes({ userId, organizationId, ...req.validated.body }),
    });
  }

  async twoFactorAdminReset(req: ValidatedRequest<{ params: { id: string } }>, res: Response) {
    await twoFactorService.adminReset({ organizationId: req.auth.organizationId, actorId: req.auth.userId, targetUserId: req.validated.params.id });
    sendSuccess(res, { message: 'Two-factor authentication was reset for this user' });
  }

  async logout(req: ValidatedRequest, res: Response) {
    const token = sessionTokenOf(req);
    if (token) await authService.logout(token);
    res.clearCookie(sessionCookieName, sessionCookieOptions);
    sendSuccess(res, { message: 'Logged out' });
  }

  async me(req: ValidatedRequest, res: Response) {
    const { userId, organizationId, email, fullName, permissions } = req.auth;
    const organization = await authService.getOrganization(organizationId);
    sendSuccess(res, { data: { id: userId, organizationId, organization, email, fullName, permissions } });
  }

  async listSessions(req: ValidatedRequest, res: Response) {
    sendSuccess(res, { data: await authService.listSessions({ userId: req.auth.userId, token: cookieToken(req) }) });
  }

  async revokeSession(req: ValidatedRequest<{ params: { id: string } }>, res: Response) {
    await authService.revokeSession({ userId: req.auth.userId, id: req.validated.params.id });
    sendSuccess(res, { message: 'Session revoked' });
  }

  async revokeOtherSessions(req: ValidatedRequest, res: Response) {
    const revoked = await authService.revokeOtherSessions({ userId: req.auth.userId, token: cookieToken(req) });
    sendSuccess(res, { message: 'Other sessions revoked', data: { revoked } });
  }

  async changePassword(req: ValidatedRequest<{ body: ChangePasswordInput }>, res: Response) {
    const { userId, organizationId } = req.auth;
    await authService.changePassword({ userId, organizationId, token: cookieToken(req), input: req.validated.body });
    sendSuccess(res, { message: 'Password changed' });
  }

  // Same 202 body whether or not the email exists.
  forgotPassword(req: ValidatedRequest<{ body: ForgotPasswordInput }>, res: Response) {
    authService.forgotPassword(req.validated.body, req.ip ?? null);
    sendSuccess(res, { statusCode: 202, message: 'If an account exists for that email, a reset link has been sent' });
  }

  async resetPassword(req: ValidatedRequest<{ body: ResetPasswordInput }>, res: Response) {
    await authService.resetPassword(req.validated.body);
    sendSuccess(res, { message: 'Password updated' });
  }
}

export const authController = new AuthController();
