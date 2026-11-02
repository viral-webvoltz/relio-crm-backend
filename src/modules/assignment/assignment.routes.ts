import { Router } from 'express';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { idParamSchema } from '@/shared/pagination/index.js';
import { assignmentController } from './assignment.controller.js';
import {
  applyUnassignedSchema,
  createRuleSchema,
  createTeamSchema,
  reorderRulesSchema,
  ruleListQuerySchema,
  setMembersSchema,
  testRuleSchema,
  updateRuleSchema,
  updateTeamSchema,
} from './assignment.validation.js';

const manage = authorize('users.manage', 'settings.manage');
const id = validateRequest({ params: idParamSchema });

export const teamsRoutes = Router();
teamsRoutes.use(authenticate, manage);
teamsRoutes.get('/', assignmentController.listTeams);
teamsRoutes.post('/', idempotent, validateRequest({ body: createTeamSchema }), assignmentController.createTeam);
teamsRoutes.get('/:id', id, assignmentController.getTeam);
teamsRoutes.patch('/:id', validateRequest({ params: idParamSchema, body: updateTeamSchema }), assignmentController.updateTeam);
teamsRoutes.put('/:id/members', validateRequest({ params: idParamSchema, body: setMembersSchema }), assignmentController.setMembers);
teamsRoutes.delete('/:id', id, assignmentController.removeTeam);

export const assignmentRulesRoutes = Router();
assignmentRulesRoutes.use(authenticate, manage);
assignmentRulesRoutes.get('/', validateRequest({ query: ruleListQuerySchema }), assignmentController.listRules);
assignmentRulesRoutes.post('/', idempotent, validateRequest({ body: createRuleSchema }), assignmentController.createRule);
// Fixed paths before /:id.
assignmentRulesRoutes.post('/reorder', validateRequest({ body: reorderRulesSchema }), assignmentController.reorder);
assignmentRulesRoutes.post('/test', validateRequest({ body: testRuleSchema }), assignmentController.test);
assignmentRulesRoutes.post('/apply', idempotent, validateRequest({ body: applyUnassignedSchema }), assignmentController.applyToUnassigned);
assignmentRulesRoutes.patch('/:id', validateRequest({ params: idParamSchema, body: updateRuleSchema }), assignmentController.updateRule);
assignmentRulesRoutes.delete('/:id', id, assignmentController.removeRule);
