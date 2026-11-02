import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

type ValidatedShape = { body?: unknown; query?: unknown; params?: unknown };

// Typed view of req.validated for a controller method: ValidatedRequest<{ body: CreateContactInput }>.
export type ValidatedRequest<T extends ValidatedShape = ValidatedShape> = Omit<Request, 'validated'> & {
  validated: {
    body: T extends { body: infer B } ? B : undefined;
    query: T extends { query: infer Q } ? Q : undefined;
    params: T extends { params: infer P } ? P : undefined;
  };
};

// Handler -> schemas, read by the OpenAPI generator (src/modules/docs).
export const routeSchemas = new WeakMap<RequestHandler, RequestSchemas>();

// Parses body/query/params with zod before the controller runs; a ZodError goes to the central error handler as a 400.
export const validateRequest = (schemas: RequestSchemas): RequestHandler => {
  const handler: RequestHandler = (req, _res, next) => {
    // The router only sees `never` here; ValidatedRequest<...> in the controller carries the real shape.
    req.validated = {
      body: schemas.body?.parse(req.body),
      query: schemas.query?.parse(req.query),
      params: schemas.params?.parse(req.params),
    } as Request['validated'];
    next();
  };
  routeSchemas.set(handler, schemas);
  return handler;
};
