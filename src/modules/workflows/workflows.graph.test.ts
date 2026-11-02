import { describe, expect, it } from 'vitest';
import { evaluateGroup, evaluateRule, getPath, render } from './workflows.conditions.js';
import { checkGraph, flatToGraph, graphSchema } from './workflows.graph.js';

const pos = { x: 0, y: 0 };
const trigger = { id: 't', type: 'trigger', position: pos, config: { event: 'deals.stage' } };
const task = (id: string) => ({ id, type: 'create_task', position: pos, config: { title: 'Do it' } });
const edge = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target });

const parse = (graph: unknown) => graphSchema.safeParse(graph);
const problems = (graph: unknown, event = 'deals.stage') => {
  const parsed = parse(graph);
  if (!parsed.success) throw new Error(parsed.error.message);
  return checkGraph(parsed.data, event);
};

describe('conditions', () => {
  const values = { stage: 'won', value: 5, flag: true, empty: '', company: { name: 'Acme' } };
  const rule = (operator: string, field: string, value?: string) => evaluateRule({ field, operator, value } as never, values, ['stage']);

  it('compares loosely so string input matches numbers and booleans', () => {
    expect(rule('equals', 'value', '5')).toBe(true);
    expect(rule('equals', 'flag', 'true')).toBe(true);
    expect(rule('not_equals', 'stage', 'lost')).toBe(true);
  });

  it('handles text, numeric, list, empty and changed operators', () => {
    expect(rule('contains', 'stage', 'wo')).toBe(true);
    expect(rule('starts_with', 'stage', 'w')).toBe(true);
    expect(rule('gt', 'value', '4')).toBe(true);
    expect(rule('lt', 'value', 'abc')).toBe(false); // non-numbers never satisfy a numeric comparison
    expect(rule('in', 'stage', 'lost, won')).toBe(true);
    expect(rule('is_empty', 'empty')).toBe(true);
    expect(rule('is_not_empty', 'stage')).toBe(true);
    expect(rule('changed', 'stage')).toBe(true);
    expect(rule('changed', 'value')).toBe(false);
  });

  it('resolves dot paths and refuses prototype keys', () => {
    expect(getPath(values, 'company.name')).toBe('Acme');
    expect(getPath(values, '__proto__')).toBeUndefined();
    expect(getPath(values, 'constructor.name')).toBeUndefined();
  });

  it('combines rules with all / any', () => {
    const rules = [
      { field: 'stage', operator: 'equals', value: 'won' },
      { field: 'value', operator: 'gt', value: '10' },
    ] as never;
    expect(evaluateGroup('all', rules, values, [])).toBe(false);
    expect(evaluateGroup('any', rules, values, [])).toBe(true);
  });

  it('renders placeholders as plain text and escapes when asked', () => {
    const context = { event: 'deals.stage', id: 'x', values: { title: '<b>Hi</b>', company: { name: 'Acme' } } };
    expect(render('{{title}} / {{company.name}} / {{missing}} / {{event}}', context)).toBe('<b>Hi</b> / Acme /  / deals.stage');
    expect(render('{{title}}', context, (s) => s.replace(/</g, '&lt;'))).toBe('&lt;b>Hi&lt;/b>');
  });
});

describe('graph validation', () => {
  it('accepts trigger -> condition -> branches', () => {
    const graph = {
      nodes: [
        trigger,
        { id: 'c', type: 'condition', position: pos, config: { mode: 'all', rules: [{ field: 'stage', operator: 'equals', value: 'won' }] } },
        task('a'),
        task('b'),
      ],
      edges: [edge('t', 'c'), edge('c', 'a', 'true'), edge('c', 'b', 'false')],
    };
    expect(problems(graph)).toEqual([]);
  });

  it('rejects loops, unconnected steps, bad handles and double connections', () => {
    expect(problems({ nodes: [trigger, task('a'), task('b')], edges: [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')] })).toContain(
      'The workflow contains a loop',
    );
    expect(problems({ nodes: [trigger, task('a')], edges: [] }).join()).toMatch(/not connected/);
    expect(problems({ nodes: [trigger, task('a')], edges: [edge('t', 'a', 'true')] }).join()).toMatch(/no "true" output/);
    expect(problems({ nodes: [trigger, task('a'), task('b')], edges: [edge('t', 'a'), { ...edge('t', 'b'), id: 'dup' }] }).join()).toMatch(/two connections/);
  });

  it('needs exactly one trigger matching the workflow trigger, and nothing flowing into it', () => {
    expect(problems({ nodes: [trigger, { ...trigger, id: 't2' }], edges: [] }).join()).toMatch(/exactly one trigger/);
    expect(problems({ nodes: [trigger], edges: [] }, 'leads.create').join()).toMatch(/does not match/);
    expect(problems({ nodes: [trigger, task('a')], edges: [edge('t', 'a'), edge('a', 't')] }).join()).toMatch(/into the trigger/);
  });

  it('only allows whitelisted, valid update_record fields', () => {
    const update = (field: string, value: string) => ({
      nodes: [trigger, { id: 'u', type: 'update_record', position: pos, config: { field, value } }],
      edges: [edge('t', 'u')],
    });
    expect(problems(update('ownerId', '5b0c5a52-6a53-4f43-9f6a-2f1b3a4d5e6f'))).toEqual([]);
    expect(problems(update('organizationId', 'x')).join()).toMatch(/cannot be changed/);
    expect(problems(update('ownerId', 'not-a-uuid')).join()).toMatch(/not a valid value/);
    expect(problems(update('lostReason', 'x'), 'orders.create').join()).toMatch(/not available/);
  });

  it('requires https for http_request and a numeric value for numeric operators', () => {
    const http = (url: string) => ({
      nodes: [trigger, { id: 'h', type: 'http_request', position: pos, config: { method: 'POST', url } }],
      edges: [edge('t', 'h')],
    });
    expect(problems(http('https://example.com/hook'))).toEqual([]);
    expect(problems(http('http://example.com/hook')).join()).toMatch(/https/);
    expect(problems(http('https://user:pw@example.com')).join()).toMatch(/credentials/);
    const rule = {
      nodes: [trigger, { id: 'c', type: 'condition', position: pos, config: { mode: 'all', rules: [{ field: 'v', operator: 'gt', value: 'abc' }] } }],
      edges: [edge('t', 'c')],
    };
    expect(parse(rule).success).toBe(false);
  });

  it('rejects unknown keys, oversized graphs and delays over 30 days', () => {
    expect(parse({ nodes: [{ ...trigger, extra: 1 }], edges: [] }).success).toBe(false);
    expect(parse({ nodes: Array.from({ length: 51 }, (_, i) => task(`n${i}`)), edges: [] }).success).toBe(false);
    const delay = (amount: number, unit: string) => ({
      nodes: [trigger, { id: 'd', type: 'delay', position: pos, config: { amount, unit } }],
      edges: [edge('t', 'd')],
    });
    expect(parse(delay(30, 'days')).success).toBe(true);
    expect(parse(delay(31, 'days')).success).toBe(false);
  });
});

describe('scheduled triggers', () => {
  const timed = (event: string, at?: string) => ({ nodes: [{ ...trigger, config: { event, ...(at && { at }) } }], edges: [] });

  it('accepts a time of day on scheduled and overdue triggers only', () => {
    expect(problems(timed('schedule.daily', '09:30'), 'schedule.daily')).toEqual([]);
    expect(problems(timed('tasks.overdue', '08:00'), 'tasks.overdue')).toEqual([]);
    expect(problems(timed('leads.create', '09:00'), 'leads.create').join()).toMatch(/only apply to scheduled/);
  });

  it('checks timezone and weekday', () => {
    const config = (event: string, extra: Record<string, string>) => ({ nodes: [{ ...trigger, config: { event, ...extra } }], edges: [] });
    expect(parse(config('schedule.daily', { timezone: 'Asia/Kolkata' })).success).toBe(true);
    expect(parse(config('schedule.daily', { timezone: 'Mars/Olympus' })).success).toBe(false);
    expect(problems(config('schedule.weekly', { day: 'fri' }), 'schedule.weekly')).toEqual([]);
    expect(problems(config('schedule.daily', { day: 'fri' }), 'schedule.daily').join()).toMatch(/weekly/);
    expect(parse(config('schedule.weekly', { day: 'friday' })).success).toBe(false);
    expect(problems(config('leads.create', { timezone: 'UTC' }), 'leads.create').join()).toMatch(/only apply to scheduled/);
  });

  it('rejects a malformed time', () => {
    expect(parse(timed('schedule.daily', '25:00')).success).toBe(false);
    expect(parse(timed('schedule.daily', '9:00')).success).toBe(false);
  });
});

describe('organization timezone setting', () => {
  it('accepts an IANA timezone and rejects anything else', async () => {
    const { settingsSchema } = await import('./workflows.validation.js');
    expect(settingsSchema.safeParse({ timezone: 'Asia/Kolkata' }).success).toBe(true);
    expect(settingsSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(settingsSchema.safeParse({ timezone: 'UTC', extra: 1 }).success).toBe(false);
  });
});

describe('legacy flat rules', () => {
  it('convert to a valid graph: trigger -> all-of condition -> chained actions', () => {
    const graph = flatToGraph(
      'deals.stage',
      [{ field: 'stage', equals: 'won' }],
      [
        { type: 'create_task', title: 'Onboard' },
        { type: 'notify', userId: 'actor', title: 'Won' },
      ],
    );
    expect(graph.nodes.map((n) => n.type)).toEqual(['trigger', 'condition', 'create_task', 'notify']);
    expect(graph.edges.map((e) => e.sourceHandle)).toEqual(['next', 'true', 'next']);
    expect(problems(graph)).toEqual([]);
  });
});
