import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { authenticate } from '@/middleware/authenticate.js';
import { authenticateCustomer } from '@/middleware/authenticate-customer.js';
import { routePermissions } from '@/middleware/authorize.js';
import { idempotent } from '@/middleware/idempotency.js';
import { routeSchemas } from '@/middleware/validate-request.js';
import type { Mount } from './docs.mounts.js';

type Json = Record<string, unknown>;
interface Layer {
  handle: RequestHandler;
  method?: string;
  route?: { path: string; stack: Layer[] };
}

// Express 5 / router v2 keeps the stack on the router but it is not in the public types.
const stackOf = (router: Router): Layer[] => Reflect.get(router, 'stack') ?? [];

export const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}') || '/';

const toSchema = (schema: z.ZodType | undefined): Json => {
  if (!schema) return {};
  try {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    return rest;
  } catch {
    return {};
  }
};

const propertiesOf = (schema: Json): [string, unknown][] => {
  const props = schema.properties;
  return typeof props === 'object' && props !== null ? Object.entries(props) : [];
};

const requiredOf = (schema: Json): string[] => (Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);

const errorRef = (description: string, code: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: { success: false, message: description, code, errors: [], requestId: 'req_123' },
    },
  },
});

const errorResponses = (secured: boolean, hasInput: boolean, hasId: boolean, isWrite: boolean): Json => ({
  ...(hasInput && { 400: errorRef('Validation failed', 'VALIDATION_ERROR') }),
  ...(secured && { 401: errorRef('Not authenticated', 'UNAUTHORIZED'), 403: errorRef('Missing permission', 'FORBIDDEN') }),
  ...(hasId && { 404: errorRef('Not found', 'NOT_FOUND') }),
  ...(isWrite && { 409: errorRef('Conflict', 'CONFLICT'), 422: errorRef('Unprocessable', 'UNPROCESSABLE_ENTITY') }),
  429: errorRef('Too many requests', 'TOO_MANY_REQUESTS'),
  500: errorRef('Internal error', 'INTERNAL_ERROR'),
});

interface Walked {
  method: string;
  path: string;
  handlers: RequestHandler[];
  auth: 'sid' | 'csid' | null;
}

// Flattens a router into (method, path, handlers, auth) tuples; router.use(authenticate) secures every route after it.
const walk = (mount: Mount): Walked[] => {
  let auth: Walked['auth'] = null;
  const out: Walked[] = [];
  for (const layer of stackOf(mount.router)) {
    if (!layer.route) {
      if (layer.handle === authenticate) auth = 'sid';
      else if (layer.handle === authenticateCustomer) auth = 'csid';
      continue;
    }
    const handlers = layer.route.stack.map((l) => l.handle);
    const routeAuth = handlers.includes(authenticate) ? 'sid' : handlers.includes(authenticateCustomer) ? 'csid' : auth;
    for (const l of layer.route.stack) {
      if (l.method) out.push({ method: l.method, path: mount.path + layer.route.path, handlers, auth: routeAuth });
    }
  }
  // A route registered for several methods repeats the stack per method; the handlers are identical so dedupe on method+path.
  return out.filter((w, i) => out.findIndex((o) => o.method === w.method && o.path === w.path) === i);
};

const operation = ({ method, path, handlers, auth }: Walked): Json => {
  const schemas = handlers.map((h) => routeSchemas.get(h)).find((s) => s !== undefined);
  const permissions = handlers.flatMap((h) => routePermissions.get(h) ?? []);
  const params = toSchema(schemas?.params);
  const query = toSchema(schemas?.query);
  const body = schemas?.body ? toSchema(schemas.body) : undefined;
  const pathNames = [...path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '');
  const idempotentRoute = handlers.includes(idempotent);

  const parameters = [
    ...pathNames.map((name) => {
      const prop = propertiesOf(params).find(([k]) => k === name)?.[1];
      return { name, in: 'path', required: true, schema: prop ?? { type: 'string' } };
    }),
    ...propertiesOf(query).map(([name, schema]) => ({ name, in: 'query', required: requiredOf(query).includes(name), schema })),
    ...(idempotentRoute ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', format: 'uuid' } }] : []),
  ];

  const isWrite = method !== 'get';
  const ok = method === 'post' && !path.endsWith('/login') ? '201' : '200';
  const success = {
    description: 'Success',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
  };
  const secured = auth !== null;

  return {
    tags: [path.split('/')[1] || 'root'],
    summary: `${method.toUpperCase()} ${toOpenApiPath(path)}`,
    ...(secured ? { security: auth === 'csid' ? [{ portalCookie: [] }] : [{ sessionCookie: [] }, { apiKey: [] }] } : { security: [] }),
    ...(permissions.length > 0 && { 'x-permissions': [...new Set(permissions)] }),
    ...(parameters.length > 0 && { parameters }),
    ...(body && { requestBody: { required: true, content: { 'application/json': { schema: body } } } }),
    responses: { [ok]: success, ...errorResponses(secured, Boolean(schemas), pathNames.length > 0, isWrite) },
  };
};

export function buildOpenApi(mounts: Mount[], version = '1.0.0'): Json {
  const paths: Record<string, Json> = {
    '/health': { get: { tags: ['health'], summary: 'Liveness', security: [], responses: { 200: { description: 'Up' } } } },
    '/health/ready': {
      get: {
        tags: ['health'],
        summary: 'Readiness (database reachable)',
        security: [],
        responses: { 200: { description: 'Ready' }, 503: { description: 'Not ready' } },
      },
    },
  };
  for (const w of mounts.flatMap(walk)) {
    const key = toOpenApiPath(w.path);
    paths[key] = { ...paths[key], [w.method]: operation(w) };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'CRM API', version },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'sid' },
        portalCookie: { type: 'apiKey', in: 'cookie', name: 'csid' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'An API key (crm_...) created under Settings > API keys' },
      },
      schemas: {
        Success: {
          type: 'object',
          required: ['success', 'message', 'data'],
          properties: { success: { const: true }, message: { type: 'string' }, data: {}, meta: { type: 'object', additionalProperties: true } },
        },
        Error: {
          type: 'object',
          required: ['success', 'message', 'code', 'errors'],
          properties: {
            success: { const: false },
            message: { type: 'string' },
            code: { type: 'string' },
            errors: { type: 'array', items: {} },
            requestId: { type: 'string' },
          },
        },
      },
    },
  };
}

export const countOperations = (doc: Json) => Object.values((doc.paths as Record<string, Json>) ?? {}).reduce((n, item) => n + Object.keys(item).length, 0);
