export const operators = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'is_empty',
  'is_not_empty',
  'changed',
] as const;
export type Operator = (typeof operators)[number];

export type Rule = { field: string; operator: Operator; value?: string | undefined };
export type Values = Record<string, unknown>;

export const noValueOperators = new Set<Operator>(['is_empty', 'is_not_empty', 'changed']);
export const numericOperators = new Set<Operator>(['gt', 'gte', 'lt', 'lte']);

export const isNumeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));

// "company.name" walks nested objects; own properties only, so a field like "__proto__" or "constructor" resolves to nothing.
export function getPath(values: Values, path: string): unknown {
  let current: unknown = values;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// Loose on purpose: "5" matches the number 5 and "true" matches true, since the editor always sends strings.
function looselyEqual(actual: unknown, expected: string) {
  if (isEmpty(actual)) return expected === '';
  const text = asText(actual);
  if (isNumeric(text) && isNumeric(expected)) return Number(text) === Number(expected);
  return text === expected;
}

export function evaluateRule(rule: Rule, values: Values, changed: readonly string[]): boolean {
  const actual = getPath(values, rule.field);
  const expected = rule.value ?? '';
  switch (rule.operator) {
    case 'equals':
      return looselyEqual(actual, expected);
    case 'not_equals':
      return !looselyEqual(actual, expected);
    case 'contains':
      return asText(actual).includes(expected);
    case 'not_contains':
      return !asText(actual).includes(expected);
    case 'starts_with':
      return asText(actual).startsWith(expected);
    case 'ends_with':
      return asText(actual).endsWith(expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const text = asText(actual);
      if (!isNumeric(text) || !isNumeric(expected)) return false;
      const [a, b] = [Number(text), Number(expected)];
      return rule.operator === 'gt' ? a > b : rule.operator === 'gte' ? a >= b : rule.operator === 'lt' ? a < b : a <= b;
    }
    case 'in':
      return expected.split(',').some((option) => looselyEqual(actual, option.trim()));
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'changed':
      return changed.includes(rule.field.split('.')[0] ?? rule.field);
  }
}

export const evaluateGroup = (mode: 'all' | 'any', rules: Rule[], values: Values, changed: readonly string[]) =>
  mode === 'all' ? rules.every((r) => evaluateRule(r, values, changed)) : rules.some((r) => evaluateRule(r, values, changed));

// {{field}} / {{a.b}} placeholders are plain text substitution: the value is looked up, never evaluated. Objects render as empty.
export const render = (template: string, context: { event: string; id: string | undefined; values: Values }, escape: (s: string) => string = (s) => s) =>
  template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key === 'event') return escape(context.event);
    if (key === 'id') return escape(context.id ?? '');
    const value = getPath(context.values, key);
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? escape(String(value)) : '';
  });
