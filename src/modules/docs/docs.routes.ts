import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { env } from '@/config/env.js';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { mounts } from './docs.mounts.js';
import { buildOpenApi } from './docs.openapi.js';

export const readVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : '1.0.0';
};

let cached: ReturnType<typeof buildOpenApi> | undefined;

const router = Router();

// Public outside production; production needs a staff session with settings.manage.
if (env.NODE_ENV === 'production') router.use(authenticate, authorize('settings.manage'));

router.get('/openapi.json', (_req, res) => {
  cached ??= buildOpenApi(mounts, readVersion());
  res.json(cached);
});

export default router;
