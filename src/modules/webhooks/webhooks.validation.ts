import { z } from 'zod';
import { urlProblem } from './webhooks.ssrf.js';

const url = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const problem = urlProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

// Event names look like `leads.create`; `*` subscribes to everything.
const events = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*)$/i),
  )
  .min(1)
  .max(50)
  .transform((list) => (list.includes('*') ? ['*'] : [...new Set(list)]));

export const createEndpointSchema = z.object({ url, events });
export const updateEndpointSchema = z
  .object({ url: url.optional(), events: events.optional(), isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const deliveryParamsSchema = z.object({ id: z.uuid(), deliveryId: z.uuid() });
export const retryQuerySchema = z.object({
  force: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type CreateEndpointInput = z.infer<typeof createEndpointSchema>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>;
export type DeliveryParams = z.infer<typeof deliveryParamsSchema>;
export type RetryQuery = z.infer<typeof retryQuerySchema>;
