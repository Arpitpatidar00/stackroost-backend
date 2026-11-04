import type { RequestHandler } from 'express';
import type { Logger } from '@/shared/logger';

/** One structured line per request, after the response is sent. No bodies, no PII. */
export const requestLogger =
  (log: Logger): RequestHandler =>
  (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route as { path?: unknown } | undefined;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log[level](
        {
          requestId: req.id,
          method: req.method,
          // Route pattern (/devices/:deviceId), not the raw URL: no ids in logs.
          path: route ? `${req.baseUrl}${String(route.path)}` : req.path,
          status: res.statusCode,
          ms: Math.round(ms),
          accountId: req.auth?.accountId,
        },
        'request',
      );
    });
    next();
  };
