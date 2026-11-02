import express, { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { AppError } from '@/shared/errors/index.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { documentsController } from './documents.controller.js';
import {
  allowedMimeTypes,
  downloadQuerySchema,
  listQuerySchemaForEntity,
  maxUploadBytes,
  renameDocumentSchema,
  uploadQuerySchema,
  versionQuerySchema,
} from './documents.validation.js';

const router = Router();

const requireAllowedType: RequestHandler = (req, _res, next) => {
  if (!req.is(allowedMimeTypes)) throw new AppError('Unsupported file type', 415, 'UNSUPPORTED_MEDIA_TYPE');
  next();
};

// Only the upload routes read raw bodies; body-parser reports an oversized body as `entity.too.large`.
const tooLarge: ErrorRequestHandler = (err, _req, _res, next) => {
  const isTooLarge = typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.too.large';
  next(isTooLarge ? new AppError('File is too large (10 MB maximum)', 413, 'FILE_TOO_LARGE') : err);
};
const rawFile = [requireAllowedType, express.raw({ type: allowedMimeTypes, limit: maxUploadBytes }), tooLarge];

router.use(authenticate);

router.get('/', authorize('documents.view'), validateRequest({ query: listQuerySchemaForEntity }), documentsController.list);
router.get('/storage', authorize('documents.view'), documentsController.storage); // before /:id
router.get('/:id', authorize('documents.view'), validateRequest({ params: idParamSchema }), documentsController.get);
router.get('/:id/download', authorize('documents.view'), validateRequest({ params: idParamSchema, query: downloadQuerySchema }), documentsController.download);
router.post('/', authorize('documents.create'), ...rawFile, validateRequest({ query: uploadQuerySchema }), documentsController.upload);
router.post(
  '/:id/versions',
  authorize('documents.create'),
  ...rawFile,
  validateRequest({ params: idParamSchema, query: versionQuerySchema }),
  documentsController.addVersion,
);
router.patch('/:id', authorize('documents.create'), validateRequest({ params: idParamSchema, body: renameDocumentSchema }), documentsController.rename);
router.delete('/:id', authorize('documents.delete'), validateRequest({ params: idParamSchema }), documentsController.remove);

export default router;
