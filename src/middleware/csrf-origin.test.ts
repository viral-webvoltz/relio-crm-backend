import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { env } from '@/config/env.js';
import { csrfOrigin } from './csrf-origin.js';

const run = (method: string, origin?: string) => {
  const next = vi.fn();
  const req = { method, protocol: 'http', get: (h: string) => (h === 'origin' ? origin : h === 'host' ? 'api.test' : undefined) } as unknown as Request;
  csrfOrigin(req, {} as never, next);
  return next.mock.calls[0]?.[0];
};

describe('csrfOrigin', () => {
  it('lets the configured frontend, same-origin and origin-less requests through', () => {
    expect(run('POST', env.CORS_ORIGIN)).toBeUndefined();
    expect(run('POST', 'http://api.test')).toBeUndefined();
    expect(run('POST')).toBeUndefined();
  });

  it('blocks a state-changing request from another origin, but not a read', () => {
    expect(run('POST', 'https://evil.example')).toMatchObject({ statusCode: 403, code: 'CSRF_BLOCKED' });
    expect(run('DELETE', 'https://evil.example')).toMatchObject({ statusCode: 403 });
    expect(run('GET', 'https://evil.example')).toBeUndefined();
  });
});
