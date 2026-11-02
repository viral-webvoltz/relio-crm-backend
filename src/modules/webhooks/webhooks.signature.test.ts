import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signatureHeader } from './webhooks.signature.js';

const sig = (secret: string) => createHmac('sha256', secret).update('100.{"a":1}').digest('hex');

describe('signatureHeader', () => {
  it('signs with a single secret', () => {
    expect(signatureHeader(['new'], 100, '{"a":1}')).toBe(`t=100,v1=${sig('new')}`);
  });
  it('adds one v1 per secret, new first', () => {
    expect(signatureHeader(['new', 'old'], 100, '{"a":1}')).toBe(`t=100,v1=${sig('new')},v1=${sig('old')}`);
  });
});
