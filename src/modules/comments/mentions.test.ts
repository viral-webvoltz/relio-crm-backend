import { describe, expect, it } from 'vitest';
import { MAX_MENTIONS, parseMentions } from './mentions.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';

describe('parseMentions', () => {
  it('extracts ids from tokens', () => {
    expect(parseMentions(`hi @[Ann Lee](user:${a}) and @[Bob](user:${b})!`)).toEqual([a, b]);
  });

  it('dedupes and lowercases', () => {
    expect(parseMentions(`@[A](user:${a.toUpperCase()}) @[A again](user:${a})`)).toEqual([a]);
  });

  it('ignores malformed tokens and plain @names', () => {
    expect(parseMentions(`@Ann @[Ann](user:not-a-uuid) [Ann](user:${a}) @[Ann](deal:${a})`)).toEqual([]);
  });

  it('caps the number of mentions', () => {
    const body = Array.from({ length: 30 }, (_, i) => `@[U](user:00000000-0000-4000-8000-${String(i).padStart(12, '0')})`).join(' ');
    expect(parseMentions(body)).toHaveLength(MAX_MENTIONS);
  });
});
