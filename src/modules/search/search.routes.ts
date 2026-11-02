import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { searchController } from './search.controller.js';
import { searchQuerySchema } from './search.validation.js';

const router = Router();

router.use(authenticate);
// Per-type permissions are checked in the controller so a partial-permission caller still gets the types they may see.
router.get('/', validateRequest({ query: searchQuerySchema }), searchController.search);

export default router;
