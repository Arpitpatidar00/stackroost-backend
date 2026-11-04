import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '@/shared/errors/AppError';
import type { Logger } from '@/shared/logger';

/** The ONLY place error responses are shaped: `{ success: false, error: {...} }`. */
export const errorHandler =
  (log: Logger): ErrorRequestHandler =>
  (err: unknown, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details ?? [] },
      });
      return;
    }
    // express.json / express.raw parse failures and oversize bodies.
    if (isHttpError(err) && err.status < 500) {
      res.status(err.status).json({
        success: false,
        error: { code: 'VALIDATION_FAILED', message: 'Malformed request body.', details: [] },
      });
      return;
    }
    log.error({ err, requestId: req.id }, 'unhandled error');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Something went wrong.', details: [] },
    });
  };

export const notFound: RequestHandler = (_req, _res, next) => {
  next(AppError.notFound('Route'));
};

const isHttpError = (e: unknown): e is { status: number } =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number';
