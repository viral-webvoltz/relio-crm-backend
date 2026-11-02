import { z } from 'zod';
import { noValueOperators, operators } from '@/modules/workflows/workflows.conditions.js';

export const assignmentResources = ['leads', 'tickets'] as const;
const resource = z.enum(assignmentResources);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

export const createTeamSchema = z.object({ name: z.string().trim().min(1).max(80), description: optionalText(300) }).strict();
export const updateTeamSchema = createTeamSchema.partial().strict();
export const setMembersSchema = z
  .object({
    userIds: z
      .array(z.uuid())
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'List each person once'),
  })
  .strict();

// "changed" only means something when a record is edited, never when it is created, so it is not offered here.
const operator = z.enum(operators).refine((o) => o !== 'changed', 'Not available for assignment');
const condition = z
  .object({
    field: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.]{1,60}$/),
    operator,
    value: z.string().max(200).optional(),
  })
  .refine((c) => noValueOperators.has(c.operator) || (c.value !== undefined && c.value !== ''), { message: 'This operator needs a value', path: ['value'] });

const target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.uuid() }),
  z.object({ type: z.literal('team'), teamId: z.uuid(), strategy: z.enum(['round_robin', 'least_loaded']).default('round_robin') }),
]);

const ruleBase = z.object({
  resource,
  name: z.string().trim().min(1).max(100),
  isActive: z.boolean().default(true),
  conditions: z.object({ mode: z.enum(['all', 'any']).default('all'), rules: z.array(condition).max(20) }),
  target,
});
export const createRuleSchema = ruleBase.strict();
export const updateRuleSchema = ruleBase.omit({ resource: true }).partial().strict();
export const reorderRulesSchema = z
  .object({
    resource,
    ids: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'List each rule once'),
  })
  .strict();
export const testRuleSchema = z
  .object({ resource, sample: z.record(z.string().max(60), z.unknown()).refine((s) => JSON.stringify(s).length <= 5_000, 'Sample is too large') })
  .strict();
export const applyUnassignedSchema = z.object({ resource, limit: z.number().int().min(1).max(500).default(200) }).strict();
export const ruleListQuerySchema = z.object({ resource: resource.optional() });

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
export type AssignmentResource = (typeof assignmentResources)[number];
