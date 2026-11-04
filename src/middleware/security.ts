import type { RequestHandler } from 'express';
import { normalizeIp, type IpAllowlist } from '@/integrations/paddle/paddle.ips';
import { AppError } from '@/shared/errors/AppError';
import type { Logger } from '@/shared/logger';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated routes (in addition to SameSite=Lax):
 * every state-changing request must carry an Origin we serve. Browsers always
 * send Origin on cross-origin and on POST/PUT/PATCH/DELETE fetches.
 */
export const requireTrustedOrigin =
  (allowed: readonly string[]): RequestHandler =>
  (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.header('origin');
    if (!origin || !allowed.includes(origin)) {
      next(new AppError('CSRF_REJECTED', 'Request origin not allowed.', 403));
      return;
    }
    next();
  };

/** Authenticated responses must never be stored by browsers or proxies. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Webhooks: only Paddle's published IPs (fail closed if the list can't be loaded). */
export const webhookIpAllowlist =
  (allowlist: IpAllowlist | null, log: Logger): RequestHandler =>
  async (req, _res, next) => {
    if (!allowlist) {
      next();
      return;
    }
    const ip = normalizeIp(req.ip ?? '');
    let allowed = false;
    try {
      allowed = await allowlist.allows(ip);
    } catch (err) {
      log.error({ err }, 'paddle IP list unavailable; rejecting webhook (Paddle will retry)');
    }
    if (!allowed) {
      log.warn({ ip, requestId: req.id }, 'webhook from non-Paddle IP rejected');
      next(AppError.forbidden('Source not allowed.'));
      return;
    }
    next();
  };
