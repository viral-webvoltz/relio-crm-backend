import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@/shared/errors/index.js';
import { extractCfFilters, validateCustomFields } from './custom-fields.validate.js';
import type { FieldDefinition } from './custom-fields.validate.js';

const def = (key: string, type: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  key,
  label: key,
  type,
  options: null,
  required: false,
  ...extra,
});
const defs = [
  def('note', 'text'),
  def('seats', 'number'),
  def('renewal', 'date'),
  def('vip', 'boolean'),
  def('tier', 'select', { options: ['gold', 'silver'] }),
  def('region', 'text', { required: true }),
];

const errorsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestError) {
      expect(e.code).toBe('INVALID_CUSTOM_FIELDS');
      return (e.errors ?? []) as { field: string; message: string }[];
    }
    throw e;
  }
  throw new Error('did not throw');
};

describe('validateCustomFields', () => {
  it('accepts valid values and drops null on create', () => {
    const out = validateCustomFields(defs, { region: 'EU', seats: 3, vip: false, tier: 'gold', renewal: '2024-02-29', note: null });
    expect(out).toEqual({ region: 'EU', seats: 3, vip: false, tier: 'gold', renewal: '2024-02-29' });
  });

  it('rejects unknown keys', () => {
    expect(errorsOf(() => validateCustomFields(defs, { region: 'x', nope: 1 })).map((e) => e.field)).toEqual(['nope']);
  });

  it('checks each type', () => {
    const fields = errorsOf(() =>
      validateCustomFields(defs, { region: 'x'.repeat(501), seats: Infinity, renewal: '2023-02-29', vip: 'yes', tier: 'bronze', note: 5 }),
    ).map((e) => e.field);
    expect(fields.sort()).toEqual(['note', 'region', 'renewal', 'seats', 'tier', 'vip']);
  });

  it('rejects malformed dates and string numbers', () => {
    expect(errorsOf(() => validateCustomFields(defs, { region: 'x', renewal: '2024-1-1', seats: '3' })).length).toBe(2);
  });

  it('requires required fields on create, including empty/null', () => {
    expect(errorsOf(() => validateCustomFields(defs, {}))[0]?.field).toBe('region');
    expect(errorsOf(() => validateCustomFields(defs, undefined))[0]?.field).toBe('region');
    expect(errorsOf(() => validateCustomFields(defs, { region: '' }))).toHaveLength(1);
  });

  it('partial: absent required is fine, null removes optional, null on required fails', () => {
    expect(validateCustomFields(defs, { seats: 2, note: null }, { partial: true })).toEqual({ seats: 2, note: null });
    expect(validateCustomFields(defs, {}, { partial: true })).toEqual({});
    expect(errorsOf(() => validateCustomFields(defs, { region: null }, { partial: true }))[0]?.field).toBe('region');
  });
});

describe('extractCfFilters', () => {
  it('reads literal and nested forms', () => {
    expect(extractCfFilters({ page: '1', 'cf[tier]': 'gold', cf: { vip: 'true' } })).toEqual({ tier: 'gold', vip: 'true' });
  });

  it('rejects repeated values', () => {
    expect(() => extractCfFilters({ 'cf[tier]': ['a', 'b'] })).toThrow(BadRequestError);
  });
});
