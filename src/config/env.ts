import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  // Number of reverse proxies in front of the API (0 = none). Needed so rate limits key on the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // Outgoing email (any SMTP provider). Both are needed; without them email features are off.
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  // Days a soft-deleted record stays in the trash before it is hard-deleted.
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  // Public URL of the web app; used for links in emails (password reset).
  APP_URL: z.string().default('http://localhost:5173'),
  // Public URL of this API; used for links in bulk email (open pixel, click redirect, one-click unsubscribe).
  API_URL: z.string().default('http://localhost:4000'),
  // Authenticated request limits per minute (in-memory, per process). 0 disables.
  RATE_LIMIT_USER_PER_MIN: z.coerce.number().int().min(0).default(300),
  RATE_LIMIT_ORG_PER_MIN: z.coerce.number().int().min(0).default(3000),
  // 'database' counts per-user/org limits in Postgres (shared by all instances); 'memory' counts per process.
  RATE_LIMIT_STORE: z.enum(['database', 'memory']).default('database'),
});

export const env = envSchema.parse(process.env);
