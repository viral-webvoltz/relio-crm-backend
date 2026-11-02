import { z } from 'zod';
import { MAX_BODY, MAX_SUBJECT, unknownPlaceholders } from '@/modules/mail/mail.templates.js';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { campaignVariables } from './campaigns.render.js';

export const campaignStatuses = ['draft', 'scheduled', 'sent', 'cancelled'] as const;
export const MAX_RECIPIENTS = 10_000;

const audienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('tag'), tagId: z.uuid() }),
  z.object({ type: z.literal('company'), companyId: z.uuid() }),
  z.object({ type: z.literal('contacts'), contactIds: z.array(z.uuid()).min(1).max(1000) }),
]);

const base = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(MAX_SUBJECT),
  bodyHtml: z.string().min(1).max(MAX_BODY),
  bodyText: z.string().min(1).max(MAX_BODY),
  audience: audienceSchema,
});

// A template may only use the placeholders the campaign knows how to fill.
const checkPlaceholders = (input: { subject?: string | undefined; bodyHtml?: string | undefined; bodyText?: string | undefined }, ctx: z.RefinementCtx) => {
  const unknown = unknownPlaceholders(`${input.subject ?? ''}\n${input.bodyHtml ?? ''}\n${input.bodyText ?? ''}`, campaignVariables);
  if (unknown.length) ctx.addIssue({ code: 'custom', path: ['bodyHtml'], message: `Unknown placeholders: ${unknown.join(', ')}` });
};

export const createCampaignSchema = base.strict().superRefine(checkPlaceholders);
export const updateCampaignSchema = base.partial().strict().superRefine(checkPlaceholders);

export const testCampaignSchema = z.object({ to: z.email().max(254) }).strict();
export const scheduleCampaignSchema = z.object({ at: z.iso.datetime() }).strict();

export const campaignListQuerySchema = listQuerySchema.extend({ status: z.enum(campaignStatuses).optional() });

export const addSuppressionSchema = z.object({ email: z.email().max(254) }).strict();

export const campaignTokenParamSchema = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/) });
export const pixelParamSchema = z.object({ file: z.string().regex(/^[a-f0-9]{48}(\.gif)?$/) });
export const clickParamSchema = z.object({ linkId: z.uuid(), token: z.string().regex(/^[a-f0-9]{48}$/) });

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type TestCampaignInput = z.infer<typeof testCampaignSchema>;
export type ScheduleCampaignInput = z.infer<typeof scheduleCampaignSchema>;
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;
