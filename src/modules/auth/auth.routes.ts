import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { accountRateLimit, authRateLimit } from '@/middleware/rate-limit.js';
import { sessionOnly } from '@/middleware/session-only.js';
import { validateRequest } from '@/middleware/validate-request.js';
import {
  twoFactorDisableSchema,
  twoFactorEnableSchema,
  twoFactorLoginSchema,
  twoFactorRecoveryCodesSchema,
  twoFactorSetupSchema,
} from './two-factor.validation.js';
import { authController } from './auth.controller.js';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema, sessionParamsSchema } from './auth.validation.js';

const router = Router();

router.post('/register', authRateLimit, validateRequest({ body: registerSchema }), authController.register);
router.post('/login', authRateLimit, accountRateLimit, validateRequest({ body: loginSchema }), authController.login);
router.post('/login/2fa', authRateLimit, validateRequest({ body: twoFactorLoginSchema }), authController.loginTwoFactor);
router.post('/logout', authController.logout);
router.get('/me', authenticate, authController.me);
router.get('/2fa', authenticate, sessionOnly, authController.twoFactorStatus);
router.post('/2fa/setup', authenticate, sessionOnly, authRateLimit, validateRequest({ body: twoFactorSetupSchema }), authController.twoFactorSetup);
router.post('/2fa/enable', authenticate, sessionOnly, authRateLimit, validateRequest({ body: twoFactorEnableSchema }), authController.twoFactorEnable);
router.post('/2fa/disable', authenticate, sessionOnly, authRateLimit, validateRequest({ body: twoFactorDisableSchema }), authController.twoFactorDisable);
router.post(
  '/2fa/recovery-codes',
  authenticate,
  sessionOnly,
  authRateLimit,
  validateRequest({ body: twoFactorRecoveryCodesSchema }),
  authController.twoFactorRecoveryCodes,
);

router.get('/sessions', authenticate, sessionOnly, authController.listSessions);
router.post('/sessions/revoke-others', authenticate, sessionOnly, authController.revokeOtherSessions);
router.delete('/sessions/:id', authenticate, validateRequest({ params: sessionParamsSchema }), authController.revokeSession);
router.post('/change-password', authenticate, sessionOnly, authRateLimit, validateRequest({ body: changePasswordSchema }), authController.changePassword);
router.post('/forgot-password', authRateLimit, validateRequest({ body: forgotPasswordSchema }), authController.forgotPassword);
router.post('/reset-password', authRateLimit, validateRequest({ body: resetPasswordSchema }), authController.resetPassword);

export default router;
