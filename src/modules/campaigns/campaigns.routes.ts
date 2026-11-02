import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { publicLinkRateLimit } from '@/middleware/rate-limit.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema, listQuerySchema } from '@/shared/pagination/index.js';
import { campaignsController } from './campaigns.controller.js';
import {
  addSuppressionSchema,
  campaignListQuerySchema,
  campaignTokenParamSchema,
  clickParamSchema,
  createCampaignSchema,
  pixelParamSchema,
  scheduleCampaignSchema,
  testCampaignSchema,
  updateCampaignSchema,
} from './campaigns.validation.js';

const router = Router();
router.use(authenticate);

// Suppressions come first so "suppressions" is never read as a campaign id.
router.get('/suppressions', authorize('campaigns.view'), validateRequest({ query: listQuerySchema }), campaignsController.suppressions);
router.post('/suppressions', authorize('campaigns.send'), validateRequest({ body: addSuppressionSchema }), campaignsController.addSuppression);
router.delete('/suppressions/:id', authorize('campaigns.send'), validateRequest({ params: idParamSchema }), campaignsController.removeSuppression);

router.get('/', authorize('campaigns.view'), validateRequest({ query: campaignListQuerySchema }), campaignsController.list);
router.get('/:id', authorize('campaigns.view'), validateRequest({ params: idParamSchema }), campaignsController.get);
router.get('/:id/audience', authorize('campaigns.view'), validateRequest({ params: idParamSchema }), campaignsController.audience);
router.get('/:id/recipients', authorize('campaigns.view'), validateRequest({ params: idParamSchema, query: listQuerySchema }), campaignsController.recipients);
router.post('/', authorize('campaigns.create'), idempotent, validateRequest({ body: createCampaignSchema }), campaignsController.create);
router.patch('/:id', authorize('campaigns.update'), validateRequest({ params: idParamSchema, body: updateCampaignSchema }), campaignsController.update);
router.delete('/:id', authorize('campaigns.delete'), validateRequest({ params: idParamSchema }), campaignsController.remove);
router.post('/:id/duplicate', authorize('campaigns.create'), idempotent, validateRequest({ params: idParamSchema }), campaignsController.duplicate);
router.post('/:id/test', authorize('campaigns.update'), validateRequest({ params: idParamSchema, body: testCampaignSchema }), campaignsController.test);
router.post('/:id/launch', authorize('campaigns.send'), idempotent, validateRequest({ params: idParamSchema }), campaignsController.launch);
router.post(
  '/:id/schedule',
  authorize('campaigns.send'),
  validateRequest({ params: idParamSchema, body: scheduleCampaignSchema }),
  campaignsController.schedule,
);
router.post('/:id/cancel', authorize('campaigns.send'), validateRequest({ params: idParamSchema }), campaignsController.cancel);

// What the people who received a campaign hit: the open pixel, tracked links and the unsubscribe page. No session; the token is the credential.
export const publicCampaignRoutes = Router();
publicCampaignRoutes.use(publicLinkRateLimit);
publicCampaignRoutes.get('/campaigns/o/:file', validateRequest({ params: pixelParamSchema }), campaignsController.pixel);
publicCampaignRoutes.get('/campaigns/c/:linkId/:token', validateRequest({ params: clickParamSchema }), campaignsController.click);
publicCampaignRoutes.get('/unsubscribe/:token', validateRequest({ params: campaignTokenParamSchema }), campaignsController.unsubscribeInfo);
publicCampaignRoutes.post('/unsubscribe/:token', validateRequest({ params: campaignTokenParamSchema }), campaignsController.unsubscribe);

export default router;
