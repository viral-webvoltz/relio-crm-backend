import express, { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { AppError } from '@/shared/errors/index.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { portalDocumentsController } from './portal-documents.controller.js';
import { allowedMimeTypes, documentListQuerySchema, maxUploadBytes, uploadQuerySchema } from './portal-documents.validation.js';

const router = Router();

const requireAllowedType: RequestHandler = (req, _res, next) => {
  if (!req.is(allowedMimeTypes)) throw new AppError('Unsupported file type', 415, 'UNSUPPORTED_MEDIA_TYPE');
  next();
};

// Only this route reads raw bodies; body-parser reports an oversized body as `entity.too.large`.
const tooLarge: ErrorRequestHandler = (err, _req, _res, next) => {
  const isTooLarge = typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.too.large';
  next(isTooLarge ? new AppError('File is too large (10 MB maximum)', 413, 'FILE_TOO_LARGE') : err);
};

router.use(authenticate, authorize('portal.manage'));
router.get('/', validateRequest({ query: documentListQuerySchema }), portalDocumentsController.list);
router.post(
  '/',
  requireAllowedType,
  express.raw({ type: allowedMimeTypes, limit: maxUploadBytes }),
  tooLarge,
  validateRequest({ query: uploadQuerySchema }),
  portalDocumentsController.upload,
);
router.delete('/:id', validateRequest({ params: idParamSchema }), portalDocumentsController.remove);

export default router;
