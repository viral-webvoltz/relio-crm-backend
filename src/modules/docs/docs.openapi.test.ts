import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { routes } from '@/routes/index.js';
import { authenticate } from '@/middleware/authenticate.js';
import { authorize } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { validateRequest } from '@/middleware/validate-request.js';
import { mounts } from './docs.mounts.js';
import { buildOpenApi, toOpenApiPath } from './docs.openapi.js';

const noop = () => undefined;

describe('toOpenApiPath', () => {
  it('converts express params', () => {
    expect(toOpenApiPath('/leads/:id/convert')).toBe('/leads/{id}/convert');
    expect(toOpenApiPath('')).toBe('/');
  });
});

describe('buildOpenApi', () => {
  const router = Router();
  router.post('/login', validateRequest({ body: z.object({ email: z.string() }) }), noop);
  router.use(authenticate);
  router.post(
    '/:id',
    authorize('leads.update'),
    idempotent,
    validateRequest({ params: z.object({ id: z.uuid() }), body: z.object({ name: z.string() }) }),
    noop,
  );
  const doc = buildOpenApi([{ path: '/things', router }]);
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;

  it('documents a public route without security', () => {
    expect(paths['/things/login']?.post?.security).toEqual([]);
  });

  it('documents an authenticated, validated, idempotent route', () => {
    const op = paths['/things/{id}']?.post;
    expect(op?.security).toEqual([{ sessionCookie: [] }, { apiKey: [] }]); // a signed-in route also accepts an API key
    expect(op?.['x-permissions']).toEqual(['leads.update']);
    expect(op?.tags).toEqual(['things']);
    expect(op?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path' }), expect.objectContaining({ name: 'Idempotency-Key', in: 'header' })]),
    );
    expect(op?.requestBody).toMatchObject({ content: { 'application/json': { schema: { required: ['name'] } } } });
    expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['201', '400', '401', '403', '404', '409', '422', '429', '500']));
  });
});

describe('mount table drift', () => {
  const source = readFileSync(new URL('../../routes/index.ts', import.meta.url), 'utf8');
  // The docs router reads the table, so it cannot list itself (that would be an import cycle); it is the one allowed exception.
  const scanned = [...source.matchAll(/routes\.use\(\s*(?:'([^']+)',\s*)?(\w+)\s*\)/g)]
    .filter((m) => m[2] !== 'auditTrail' && m[2] !== 'docsRoutes')
    .map((m) => m[1] ?? '');

  it('lists every path routes/index.ts mounts', () => {
    expect(mounts.map((m) => m.path)).toEqual(scanned);
  });

  it('matches the number of routers actually mounted', () => {
    const routerLayers = (Reflect.get(routes, 'stack') as { route?: unknown; handle: { stack?: unknown } }[]).filter(
      (l) => !l.route && Array.isArray(l.handle.stack),
    );
    expect(routerLayers).toHaveLength(mounts.length + 1); // + the docs router itself
  });
});
