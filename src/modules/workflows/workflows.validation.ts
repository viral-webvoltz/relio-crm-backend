import { z } from 'zod';
import { checkGraph, graphSchema, isTimezone, type Graph } from './workflows.graph.js';

const triggerEvent = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'Use an event like deals.stage');

const base = z.object({
  name: z.string().trim().min(1).max(100),
  trigger: triggerEvent,
  isActive: z.boolean(),
  graph: graphSchema,
});

const triggerOf = (graph: Graph) => graph.nodes.find((n) => n.type === 'trigger')?.config.event;

// The trigger is also stored on the row (the list page and the event lookup use it), so it must agree with the trigger step.
const validateGraph = (input: { trigger?: string | undefined; graph?: Graph | undefined }, ctx: z.RefinementCtx) => {
  if (!input.graph) {
    if (input.trigger) ctx.addIssue({ code: 'custom', path: ['trigger'], message: 'Send the graph together with a new trigger' });
    return;
  }
  const event = input.trigger ?? triggerOf(input.graph) ?? '';
  for (const message of checkGraph(input.graph, event)) ctx.addIssue({ code: 'custom', path: ['graph'], message });
};

export const createWorkflowSchema = base
  .partial({ trigger: true, isActive: true })
  .strict()
  .superRefine(validateGraph)
  .transform((input) => ({ ...input, trigger: input.trigger ?? triggerOf(input.graph) ?? '', isActive: input.isActive ?? true }));
// runAsMe: the caller takes over the workflow, so scheduled runs act as them (used when the original creator is gone).
export const updateWorkflowSchema = base
  .partial()
  .extend({ runAsMe: z.literal(true).optional() })
  .strict()
  .superRefine(validateGraph);

export const settingsSchema = z.object({ timezone: z.string().trim().max(60).refine(isTimezone, 'Unknown timezone') }).strict();

// Dry run: a made-up record, plus which fields count as "changed" (for the `changed` operator).
export const testWorkflowSchema = z
  .object({
    sample: z.record(z.string().max(60), z.unknown()).refine((s) => JSON.stringify(s).length <= 20_000, 'Sample is too large'),
    changed: z.array(z.string().max(60)).max(50).default([]),
  })
  .strict();

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
export type TestWorkflowInput = z.infer<typeof testWorkflowSchema>;
