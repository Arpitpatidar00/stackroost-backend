import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError } from '@/shared/errors/AppError';

export interface RequestSchemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

type Validated<S extends RequestSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.infer<S[K]> : never;
};

/**
 * Route-level validation. Parsed values REPLACE the raw input (unknown keys
 * stripped, types coerced), so nothing unvalidated reaches a service.
 */
export const validate =
  (schemas: RequestSchemas): RequestHandler =>
  (req, _res, next) => {
    const validated: NonNullable<Request['validated']> = {};
    const issues: { in: string; path: string; message: string }[] = [];
    for (const key of ['body', 'params', 'query'] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (result.success) validated[key] = result.data;
      else
        issues.push(
          ...result.error.issues.map((i) => ({
            in: key,
            path: i.path.join('.'),
            message: i.message,
          })),
        );
    }
    if (issues.length > 0) {
      next(AppError.validation(issues));
      return;
    }
    req.validated = validated;
    next();
  };

/** Typed read of what `validate(schemas)` stored for this route. */
export function input<S extends RequestSchemas>(req: Request, _schemas: S): Validated<S> {
  if (!req.validated) throw new Error('input() used on a route without validate()');
  return req.validated as Validated<S>;
}
