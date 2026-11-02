import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { organizations, users } from '@/database/schema/index.js';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { sessionOnly } from '@/middleware/session-only.js';
import { validateRequest, type ValidatedRequest } from '@/middleware/validate-request.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { audit } from '@/shared/utils/audit.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { AppError, BadRequestError } from '@/shared/errors/index.js';
import { sendViaGmail } from '@/modules/mail/gmail.client.js';
import { mailSettings } from '@/modules/mail/mail.settings.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import {
  createMailAccountSchema,
  testMailSchema,
  updateMailAccountSchema,
  updateOrganizationSchema,
  type CreateMailAccountBody,
  type TestMailBody,
  type UpdateMailAccountBody,
  type UpdateOrganizationInput,
} from './organization.validation.js';

// The slug is the sign-in and portal-link identifier, so it is shown but never edited here.
const columns = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  timezone: organizations.timezone,
  createdAt: organizations.createdAt,
};

const router = Router();
router.use(authenticate);

router.get('/', async (req, res: Response) => {
  const [org] = await db.select(columns).from(organizations).where(eq(organizations.id, req.auth.organizationId));
  if (!org) throw new NotFoundError('Organization not found');
  const members = await db.$count(users, eq(users.organizationId, org.id));
  sendSuccess(res, { data: { ...org, memberCount: members } });
});

router.patch(
  '/',
  sessionOnly,
  authorize('settings.manage'),
  validateRequest({ body: updateOrganizationSchema }),
  async (req: ValidatedRequest<{ body: UpdateOrganizationInput }>, res: Response) => {
    const { organizationId, userId } = req.auth;
    const [org] = await db
      .update(organizations)
      .set({ ...req.validated.body, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId))
      .returning(columns);
    if (!org) throw new NotFoundError('Organization not found');
    await audit({
      organizationId,
      actorUserId: userId,
      action: 'organization.updated',
      targetType: 'organization',
      targetId: organizationId,
      metadata: { fields: Object.keys(req.validated.body) },
    });
    sendSuccess(res, { message: 'Organization saved', data: org });
  },
);

// The Gmail accounts this organization can send email from, and which one is active. Secrets go in and are sealed; they are never sent back.
type AccountParams = { id: string };

router.get('/mail', authorize('settings.manage'), async (req, res: Response) => {
  sendSuccess(res, { data: await mailSettings.list(req.auth.organizationId) });
});

router.post('/mail', sessionOnly, authorize('settings.manage'), validateRequest({ body: createMailAccountSchema }), async (req: ValidatedRequest<{ body: CreateMailAccountBody }>, res: Response) => {
  const { organizationId, userId } = req.auth;
  const account = await mailSettings.create(organizationId, { ...req.validated.body, fromName: req.validated.body.fromName });
  await audit({ organizationId, actorUserId: userId, action: 'organization.mail_account_added', targetType: 'organization', targetId: organizationId, metadata: { fromEmail: account.fromEmail } });
  sendSuccess(res, { statusCode: 201, message: 'Email account added', data: account });
});

router.put(
  '/mail/:id',
  sessionOnly,
  authorize('settings.manage'),
  validateRequest({ params: idParamSchema, body: updateMailAccountSchema }),
  async (req: ValidatedRequest<{ params: AccountParams; body: UpdateMailAccountBody }>, res: Response) => {
    const { organizationId, userId } = req.auth;
    const account = await mailSettings.update(organizationId, req.validated.params.id, req.validated.body);
    await audit({ organizationId, actorUserId: userId, action: 'organization.mail_account_updated', targetType: 'organization', targetId: organizationId, metadata: { fromEmail: account.fromEmail } });
    sendSuccess(res, { message: 'Email account saved', data: account });
  },
);

router.post('/mail/:id/activate', sessionOnly, authorize('settings.manage'), validateRequest({ params: idParamSchema }), async (req: ValidatedRequest<{ params: AccountParams }>, res: Response) => {
  const { organizationId, userId } = req.auth;
  await mailSettings.activate(organizationId, req.validated.params.id);
  await audit({ organizationId, actorUserId: userId, action: 'organization.mail_account_activated', targetType: 'organization', targetId: organizationId, metadata: { accountId: req.validated.params.id } });
  sendSuccess(res, { message: 'Email account is now active', data: await mailSettings.list(organizationId) });
});

router.delete('/mail/:id', sessionOnly, authorize('settings.manage'), validateRequest({ params: idParamSchema }), async (req: ValidatedRequest<{ params: AccountParams }>, res: Response) => {
  const { organizationId, userId } = req.auth;
  await mailSettings.remove(organizationId, req.validated.params.id);
  await audit({ organizationId, actorUserId: userId, action: 'organization.mail_account_removed', targetType: 'organization', targetId: organizationId, metadata: { accountId: req.validated.params.id } });
  sendSuccess(res, { message: 'Email account removed' });
});

// Sends straight away (not through the outbox) from the chosen account, active or not, so a wrong credential is reported here instead of failing later.
router.post(
  '/mail/:id/test',
  sessionOnly,
  authorize('settings.manage'),
  validateRequest({ params: idParamSchema, body: testMailSchema }),
  async (req: ValidatedRequest<{ params: AccountParams; body: TestMailBody }>, res: Response) => {
    const { organizationId, userId } = req.auth;
    const gmail = await mailSettings.credentialsFor(organizationId, req.validated.params.id);
    const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const to = req.validated.body.to ?? me?.email;
    if (!to) throw new BadRequestError('No address to send the test to', 'NO_RECIPIENT');
    try {
      await sendViaGmail(gmail, {
        to,
        subject: 'Test email from your CRM',
        text: 'This is a test message. If you are reading it, your CRM can send email from this account.',
        html: '<p>This is a test message. If you are reading it, your CRM can send email from this account.</p>',
      });
    } catch (err) {
      throw new AppError(err instanceof Error ? err.message : 'The test email could not be sent', 502, 'MAIL_TEST_FAILED');
    }
    sendSuccess(res, { message: `Test email sent to ${to}` });
  },
);

export default router;
