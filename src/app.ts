import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { appConfig } from '@/config/app.config.js';
import { env } from '@/config/env.js';
import { routes } from '@/routes/index.js';
import { apiRateLimit } from '@/middleware/rate-limit.js';
import { csrfOrigin } from '@/middleware/csrf-origin.js';
import { requestLogger } from '@/middleware/request-logger.js';
import { errorHandler, notFound } from '@/middleware/error-handler.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  app.use(requestLogger);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: appConfig.jsonBodyLimit }));
  app.use(cookieParser());
  app.use(csrfOrigin);

  app.use(appConfig.apiPrefix, apiRateLimit, routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
