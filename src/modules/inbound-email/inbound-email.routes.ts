import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { apiRateLimit } from '@/middleware/rate-limit.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { parseInbound } from './inbound-email.parse.js';
import { inboundEmailService } from './inbound-email.service.js';

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Mounted at /inbound. No user auth: a shared secret (INBOUND_EMAIL_SECRET) is the only way in; unset = endpoint does not exist.
// The 1 MB body limit comes from the global express.json in app.ts.
const router = Router();

router.post('/email', apiRateLimit, async (req, res) => {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret) throw new NotFoundError('Not found');
  const given = req.get('x-inbound-secret');
  if (!given || !safeEqual(given, secret)) throw new UnauthorizedError('Invalid inbound secret');

  const email = parseInbound(req.body);
  if (!email) throw new BadRequestError('Unrecognised inbound email payload', 'INVALID_INBOUND_PAYLOAD');
  const { status, body } = await inboundEmailService.process(email);
  sendSuccess(res, { statusCode: status, data: body });
});

export default router;
