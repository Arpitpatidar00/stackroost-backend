import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import { AppError } from '@/shared/errors/AppError';

export type StoreFactory = (prefix: string) => Store | undefined;

/**
 * Per-route budgets. With a shared store (Postgres in production) the limits
 * hold across every API instance; without one (tests) they're in-memory.
 */
export function createRateLimits(store: StoreFactory = () => undefined) {
  const limiter = (
    name: string,
    windowMinutes: number,
    limit: number,
    keyGenerator?: (req: Request) => string,
  ) =>
    rateLimit({
      windowMs: windowMinutes * 60_000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: store(`${name}:`),
      ...(keyGenerator && { keyGenerator }),
      handler: (_req, _res, next) => {
        next(new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', 429));
      },
    });

  // Signed-in: per account. Otherwise per IP — IPv6 grouped by /56 so rotating
  // addresses inside one allocation can't bypass the limit.
  const byAccount = (req: Request) =>
    req.auth ? `acct:${req.auth.accountId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;

  return {
    /** Google sign-in round trips. */
    auth: limiter('auth', 15, 30),
    /** Checkout/plan changes: each call hits Paddle. Per account. */
    billing: limiter('billing', 15, 30, byAccount),
    /** Coupon guessing. Per account. */
    coupons: limiter('coupons', 15, 20, byAccount),
    /** Desktop activation/refresh: key brute force must be impractical. */
    licensing: limiter('licensing', 15, 60),
    /** Admin API, per admin. */
    admin: limiter('admin', 1, 120, byAccount),
    /** Everything else. */
    general: limiter('general', 1, 300),
  };
}

export type RateLimits = ReturnType<typeof createRateLimits>;
