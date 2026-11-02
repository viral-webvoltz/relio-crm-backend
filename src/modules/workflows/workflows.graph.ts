import { z } from 'zod';
import { fieldProblem } from './workflows.records.js';
import { isNumeric, noValueOperators, numericOperators, operators } from './workflows.conditions.js';

export const DEFAULT_AT = '09:00';
export const DEFAULT_DAY = 'mon';
export const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function isTimezone(name: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export const MAX_NODES = 50;
export const MAX_EDGES = 100;
export const MAX_DELAY_MINUTES = 30 * 24 * 60;

const id = z.string().trim().min(1).max(100);
const required = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).optional(); // the editor sends "" for an empty optional box
const position = z.object({ x: z.number().min(-100_000).max(100_000), y: z.number().min(-100_000).max(100_000) }).strict();
const target = z.union([z.literal('actor'), z.uuid()]);

const ruleSchema = z
  .object({ field: required(100), operator: z.enum(operators), value: z.string().max(200).optional() })
  .strict()
  .superRefine((rule, ctx) => {
    if (noValueOperators.has(rule.operator)) return;
    if (rule.value === undefined || rule.value === '') ctx.addIssue({ code: 'custom', path: ['value'], message: 'A value is required' });
    else if (numericOperators.has(rule.operator) && !isNumeric(rule.value)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Must be a number' });
  });

const node = <T extends string, C extends z.ZodType>(type: T, config: C) => z.object({ id, type: z.literal(type), position, config }).strict();

const nodeSchema = z.discriminatedUnion('type', [
  node(
    'trigger',
    z
      .object({
        event: required(100),
        at: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00')
          .optional(), // scheduled triggers: time of day, in `timezone`
        timezone: z.string().max(60).refine(isTimezone, 'Unknown timezone').optional(), // IANA name such as Asia/Kolkata; default UTC
        day: z.enum(weekdays).optional(), // schedule.weekly only; default mon
      })
      .strict(),
  ),
  node('condition', z.object({ mode: z.enum(['all', 'any']), rules: z.array(ruleSchema).min(1).max(10) }).strict()),
  node(
    'create_task',
    z
      .object({
        title: required(200),
        description: optional(2000),
        priority: z.enum(['low', 'medium', 'high']).default('medium'),
        dueInDays: z.number().int().min(0).max(365).optional(),
        assignTo: target.default('actor'),
      })
      .strict(),
  ),
  node('notify', z.object({ userId: target, title: required(200), body: optional(1000) }).strict()),
  node('update_record', z.object({ field: required(60), value: z.string().max(500) }).strict()),
  node(
    'send_email',
    z
      .object({
        to: z.union([z.email().max(254), z.string().regex(/^\{\{\s*[\w.]+\s*\}\}$/, 'Use an email address or a placeholder like {{email}}')]),
        subject: required(200),
        body: required(5000),
      })
      .strict(),
  ),
  node('http_request', z.object({ method: z.enum(['POST', 'PUT', 'GET']), url: required(2048), body: optional(5000) }).strict()),
  node(
    'delay',
    z
      .object({ amount: z.number().int().min(1), unit: z.enum(['minutes', 'hours', 'days']) })
      .strict()
      .refine((c) => delayMinutes(c) <= MAX_DELAY_MINUTES, { message: 'A delay can be at most 30 days', path: ['amount'] }),
  ),
]);

const edgeSchema = z.object({ id, source: id, sourceHandle: z.enum(['next', 'true', 'false']), target: id }).strict();

export const graphSchema = z.object({ nodes: z.array(nodeSchema).min(1).max(MAX_NODES), edges: z.array(edgeSchema).max(MAX_EDGES) }).strict();

export type Graph = z.infer<typeof graphSchema>;
export type GraphNode = Graph['nodes'][number];
export type GraphEdge = Graph['edges'][number];
export type NodeOf<T extends GraphNode['type']> = Extract<GraphNode, { type: T }>;

export const delayMinutes = ({ amount, unit }: { amount: number; unit: 'minutes' | 'hours' | 'days' }) =>
  amount * (unit === 'minutes' ? 1 : unit === 'hours' ? 60 : 1440);

const handlesFor = (type: GraphNode['type']): readonly string[] => (type === 'condition' ? ['true', 'false'] : ['next']);

// Triggers the scheduler fires (once per day, at the trigger's `at` time, default 09:00, in its timezone), not user actions in the app.
export const isTimedTrigger = (event: string) => event.startsWith('schedule.') || event.endsWith('.overdue');

export const triggerResource = (event: string) => event.split('.')[0];

// Structure and per-step checks that a schema cannot express. Returns human-readable problems; empty means the graph is sound.
export function checkGraph(graph: Graph, event: string): string[] {
  const problems: string[] = [];
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) problems.push(`Duplicate step id ${n.id}`);
    byId.set(n.id, n);
  }

  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) problems.push('A workflow needs exactly one trigger step');
  const trigger = triggers[0];
  if (trigger?.type === 'trigger' && trigger.config.event !== event) problems.push('The trigger step does not match the workflow trigger');
  if (trigger?.type === 'trigger') {
    const { at, timezone, day } = trigger.config;
    if ((at || timezone) && !isTimedTrigger(event)) problems.push('A time of day and timezone only apply to scheduled triggers');
    if (day && event !== 'schedule.weekly') problems.push('A weekday only applies to the weekly schedule');
  }

  const incoming = new Map<string, number>();
  const used = new Set<string>();
  for (const e of graph.edges) {
    const source = byId.get(e.source);
    const targetNode = byId.get(e.target);
    if (!source || !targetNode) {
      problems.push(`Connection ${e.id} points to a step that does not exist`);
      continue;
    }
    if (e.source === e.target) problems.push('A step cannot connect to itself');
    if (!handlesFor(source.type).includes(e.sourceHandle)) problems.push(`Step ${source.id} has no "${e.sourceHandle}" output`);
    if (targetNode.type === 'trigger') problems.push('Nothing can connect into the trigger');
    const key = `${e.source}:${e.sourceHandle}`;
    if (used.has(key)) problems.push(`Step ${e.source} has two connections on its "${e.sourceHandle}" output`);
    used.add(key);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  }
  for (const n of graph.nodes) if (n.type !== 'trigger' && !incoming.has(n.id)) problems.push(`Step ${n.id} is not connected to the trigger`);

  // Acyclic: repeatedly remove steps with no remaining incoming connection; anything left sits on a cycle.
  const indegree = new Map(graph.nodes.map((n) => [n.id, incoming.get(n.id) ?? 0]));
  const queue = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  let removed = 0;
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    removed++;
    for (const e of graph.edges) {
      if (e.source !== id || !byId.has(e.target)) continue;
      const left = (indegree.get(e.target) ?? 0) - 1;
      indegree.set(e.target, left);
      if (left === 0) queue.push(e.target);
    }
  }
  if (removed < graph.nodes.length) problems.push('The workflow contains a loop');

  const resource = triggerResource(event);
  for (const n of graph.nodes) {
    if (n.type === 'update_record') {
      const problem = fieldProblem(resource, n.config.field, n.config.value);
      if (problem) problems.push(problem);
    }
    if (n.type === 'http_request') {
      const problem = urlShapeProblem(n.config.url);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

// Cheap static check; the real protection (DNS resolution against private ranges) happens at run time.
function urlShapeProblem(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/\{\{[^}]*\}\}/g, 'x'));
    if (url.protocol !== 'https:') return 'HTTP request URLs must use https';
    if (url.username || url.password) return 'HTTP request URLs must not contain credentials';
    return null;
  } catch {
    return 'HTTP request URL is invalid';
  }
}

// Legacy flat rule (conditions + actions) -> graph: trigger, then one all-of condition if there are conditions, then the actions in a chain.
type FlatAction =
  | { type: 'create_task'; title: string; description?: string; priority?: 'low' | 'medium' | 'high'; dueInDays?: number; assignTo?: string }
  | { type: 'notify'; userId: string; title: string; body?: string };

export function flatToGraph(event: string, conditions: { field: string; equals: string | number | boolean }[], actions: FlatAction[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let y = 0;
  const add = (n: Omit<GraphNode, 'position'> & { position?: never }) => {
    nodes.push({ ...n, position: { x: 0, y } } as GraphNode);
    y += 170;
  };
  const link = (source: string, sourceHandle: 'next' | 'true', targetId: string) =>
    edges.push({ id: `${source}:${sourceHandle}->${targetId}`, source, sourceHandle, target: targetId });

  add({ id: 'trigger', type: 'trigger', config: { event } });
  let last = { id: 'trigger', handle: 'next' as 'next' | 'true' };
  if (conditions.length > 0) {
    add({
      id: 'condition',
      type: 'condition',
      config: { mode: 'all', rules: conditions.map((c) => ({ field: c.field, operator: 'equals' as const, value: String(c.equals) })) },
    });
    link(last.id, last.handle, 'condition');
    last = { id: 'condition', handle: 'true' };
  }
  actions.forEach((a, i) => {
    const nodeId = `action${i}`;
    if (a.type === 'create_task') {
      add({
        id: nodeId,
        type: 'create_task',
        config: {
          title: a.title,
          description: a.description,
          priority: a.priority ?? 'medium',
          dueInDays: a.dueInDays,
          assignTo: (a.assignTo ?? 'actor') as 'actor',
        },
      });
    } else add({ id: nodeId, type: 'notify', config: { userId: a.userId as 'actor', title: a.title, body: a.body } });
    link(last.id, last.handle, nodeId);
    last = { id: nodeId, handle: 'next' };
  });
  return { nodes, edges };
}
