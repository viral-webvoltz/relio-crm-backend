import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '@/shared/utils/logger.js';

// Reuses an upstream x-request-id (load balancer) or mints one; echoed back so clients can quote it.
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w.-]{1,100}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }) },
});
