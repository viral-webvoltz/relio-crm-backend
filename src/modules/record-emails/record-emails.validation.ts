import { z } from 'zod';

export const sendRecordEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
});

export type SendRecordEmailInput = z.infer<typeof sendRecordEmailSchema>;
