import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, NotFoundError } from '@/shared/errors/index.js';

export const notFound: RequestHandler = (_req, _res, next) => next(new NotFoundError('Route not found'));

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && 'cause' in err && (err.cause as { code?: string } | null)?.code === '23505';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.id;
  if (err instanceof ZodError) {
    res.status(400).json({ success: false, message: 'Validation failed', code: 'VALIDATION_ERROR', errors: err.issues, requestId });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, message: err.message, code: err.code, errors: err.errors ?? [], requestId });
    return;
  }
  if (isUniqueViolation(err)) {
    res.status(409).json({ success: false, message: 'A record with these details already exists', code: 'CONFLICT', errors: [], requestId });
    return;
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ success: false, message: 'Internal server error', code: 'INTERNAL_ERROR', errors: [], requestId });
};
