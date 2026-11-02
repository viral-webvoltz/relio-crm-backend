import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { BadRequestError } from '@/shared/errors/index.js';

export const entityTypes = ['lead', 'contact', 'deal'] as const;
export type EntityType = (typeof entityTypes)[number];
export const fieldTypes = ['text', 'number', 'date', 'boolean', 'select'] as const;
export type FieldType = (typeof fieldTypes)[number];

export type FieldDefinition = { key: string; label: string; type: string; options: string[] | null; required: boolean };
export type FieldErrors = { field: string; message: string }[];

const isRealDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const checkValue = (def: FieldDefinition, value: unknown): string | null => {
  switch (def.type) {
    case 'text':
      if (typeof value !== 'string') return 'Must be a string';
      return value.length > 500 ? 'Must be at most 500 characters' : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'Must be a finite number';
    case 'date':
      return typeof value === 'string' && isRealDate(value) ? null : 'Must be a real date (YYYY-MM-DD)';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Must be a boolean';
    case 'select':
      return typeof value === 'string' && (def.options ?? []).includes(value) ? null : 'Must be one of the allowed options';
    default:
      return 'Unsupported field type';
  }
};

/**
 * Validates `input` against the active definitions and returns the cleaned object.
 * create (default): required fields must be present; null/'' values are dropped.
 * partial (updates): absent keys are left alone and null/'' are kept as null so the caller removes them;
 * a required field explicitly set to null/'' is still an error.
 */
export function validateCustomFields(
  definitions: FieldDefinition[],
  input: Record<string, unknown> | null | undefined,
  { partial = false }: { partial?: boolean } = {},
): Record<string, unknown> {
  const submitted = input ?? {};
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const errors: FieldErrors = [];
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(submitted)) {
    const def = byKey.get(key);
    if (!def) {
      errors.push({ field: key, message: 'Unknown custom field' });
      continue;
    }
    if (value === null || value === '' || value === undefined) {
      if (def.required) errors.push({ field: key, message: 'Required' });
      else if (partial) out[key] = null;
      continue;
    }
    const problem = checkValue(def, value);
    if (problem) errors.push({ field: key, message: problem });
    else out[key] = value;
  }

  if (!partial) {
    for (const def of definitions) {
      if (def.required && !(def.key in out) && !errors.some((e) => e.field === def.key)) errors.push({ field: def.key, message: 'Required' });
    }
  }

  if (errors.length) throw new BadRequestError('Invalid custom fields', 'INVALID_CUSTOM_FIELDS', errors);
  return out;
}

// Express' default query parser keeps `cf[key]=v` as the literal key "cf[key]"; also accept the nested form.
export function extractCfFilters(query: unknown): Record<string, string> {
  const filters: Record<string, string> = {};
  if (typeof query !== 'object' || query === null) return filters;
  const add = (key: string, value: unknown) => {
    if (typeof value !== 'string') throw new BadRequestError(`Invalid value for cf[${key}]`, 'INVALID_CUSTOM_FIELD_FILTER');
    filters[key] = value;
  };
  for (const [k, v] of Object.entries(query)) {
    const m = /^cf\[(.+)\]$/.exec(k);
    if (m?.[1]) add(m[1], v);
    else if (k === 'cf' && typeof v === 'object' && v !== null) for (const [ck, cv] of Object.entries(v)) add(ck, cv);
  }
  return filters;
}

// Equality filters, e.g. custom_fields ->> 'tier' = 'gold'. Keys must already be checked against active definitions.
export const cfFilterConditions = (column: AnyPgColumn, cf: Record<string, string> | undefined) =>
  Object.entries(cf ?? {}).map(([key, value]) => sql`${column} ->> ${key} = ${value}`);

// Atomic merge of a validated patch; null values remove their key.
export const mergeCustomFields = (column: AnyPgColumn, patch: Record<string, unknown>) => sql`jsonb_strip_nulls(${column} || ${JSON.stringify(patch)}::jsonb)`;
